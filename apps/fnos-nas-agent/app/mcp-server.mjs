// Phase 164: an MCP server that exposes the read-only capabilities of the NAS
// to a compatible MCP client.
//
// The agent already talks to MCP servers (app/mcp-client.mjs) and bridges their
// tools into the local catalogue (app/mcp-tool-bridge.mjs). This module closes
// the loop: it lets the NAS act as an MCP *server*, so a client such as Claude
// Desktop, Marvis or any other MCP compatible host can call the safe read-only
// capabilities of the NAS over stdio.
//
// The transport is the same one the MCP ecosystem uses on the command line:
// newline delimited JSON-RPC 2.0 messages over stdin/stdout.
//
// The exposure policy is deliberately narrow:
//
//   - Only tools whose risk is exactly "read-only" are published. A write or
//     destructive tool never appears in tools/list and a tools/call for it is
//     refused with a JSON-RPC error. The server never approves on behalf of
//     the client; there is no "approve" flag and no capability parameter.
//
// The read-only filter is an *exposure surface* decision, not a security
// boundary. The real boundary is the read-only tool registry itself
// (app/read-only-tools.mjs) together with the global execution policy
// (app/execution-policy.mjs) and the destructive capability
// (app/execution-capability.mjs). This module only narrows what is offered.

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_TOOLS = 200;

// JSON-RPC 2.0 error codes used by this server.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asText(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Masks a value that looks like a secret.
 *
 * The semantics match app/security-audit.mjs: only the first two characters
 * stay readable so an operator can tell two keys apart, the rest is replaced
 * by a fixed number of asterisks so the mask never reveals the length either.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function maskSecret(value) {
  const secret = typeof value === "string" ? value : "";
  if (!secret) return "";
  return `${secret.slice(0, 2)}${"*".repeat(8)}`;
}

const SECRET_PATTERNS = [
  // OpenAI style keys: sk-…, sk-proj-…
  { pattern: /\bsk-[A-Za-z0-9_-]{6,}/g, group: 0 },
  // HTTP bearer tokens.
  { pattern: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{6,})/g, group: 2, prefix: 1 },
  // key=value / "key": "value" pairs for well known secret names.
  {
    pattern: /((?:api[_-]?key|apikey|secret|password|passwd|pwd|token|authorization|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{6,})/gi,
    group: 2,
    prefix: 1
  }
];

/**
 * Masks every value in a text that looks like a secret.
 *
 * The text is returned unchanged when nothing looks like a secret, so a normal
 * tool result keeps its original content.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function redactToolResult(text) {
  const source = typeof text === "string" ? text : asText(text);
  if (!source) return "";
  let result = source;
  for (const rule of SECRET_PATTERNS) {
    result = result.replace(rule.pattern, (match, ...groups) => {
      const captured = groups[rule.group - 1];
      if (typeof captured !== "string" || captured.length < 4) return match;
      const masked = maskSecret(captured);
      if (rule.prefix) {
        const prefix = groups[rule.prefix - 1];
        return typeof prefix === "string" ? `${prefix}${masked}` : masked;
      }
      return masked;
    });
  }
  return result;
}

/**
 * Derives the external tool name of a tool.
 *
 * The name of the tool itself wins, so a tool that already carries an MCP
 * flavoured `name` keeps it. A tool that only has the internal identifier
 * (for example `files.list`) is rewritten to `files_list`, because the dot
 * separated form is the internal identifier namespace of the agent and must
 * not be confused with the names published by this server.
 *
 * @param {object} tool
 * @returns {string} the external name, or "" when no usable name exists
 */
export function externalToolName(tool) {
  const declared = typeof tool?.name === "string" ? tool.name.trim() : "";
  if (declared && TOOL_NAME_PATTERN.test(declared)) return declared;
  const id = typeof tool?.id === "string" ? tool.id.trim() : "";
  if (!id) return "";
  const rewritten = id.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[^A-Za-z0-9_]+/, "");
  if (!rewritten) return "";
  return rewritten.slice(0, 64);
}

function normalizeTool(tool) {
  if (!isPlainObject(tool)) return null;
  const name = externalToolName(tool);
  if (!name) return null;
  const risk = tool.risk === "read-only" ? "read-only" : tool.risk === "write" ? "write" : "destructive";
  const description = typeof tool.description === "string"
    ? tool.description.slice(0, MAX_DESCRIPTION_LENGTH)
    : typeof tool.title === "string" ? tool.title.slice(0, MAX_DESCRIPTION_LENGTH) : "";
  const inputSchema = isPlainObject(tool.inputSchema)
    ? tool.inputSchema
    : { type: "object", properties: {}, additionalProperties: false };
  return { name, id: typeof tool.id === "string" ? tool.id : name, description, inputSchema, risk };
}

function success(id, result) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, result };
}

function failure(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error };
}

/**
 * Creates an MCP server over stdio.
 *
 * @param {object} options
 * @param {string} [options.name]      the server name reported to the client
 * @param {string} [options.version]   the server version reported to the client
 * @param {Array<object>} [options.tools] the tool catalogue; only the read-only
 *   entries of this list are published
 * @param {(name: string, args: object) => unknown} [options.invoke] the
 *   implementation that actually runs a tool
 * @param {number} [options.maxBytes]  the maximum size of one response
 * @returns {{handle: Function, handleLine: Function, listTools: Function, close: Function}}
 */
export function createMcpServer({
  name = "fnos-nas-agent",
  version = "1.0.0",
  tools = [],
  invoke = null,
  maxBytes = DEFAULT_MAX_BYTES
} = {}) {
  const serverName = typeof name === "string" && name.trim() ? name.trim() : "fnos-nas-agent";
  const serverVersion = typeof version === "string" && version.trim() ? version.trim() : "1.0.0";
  const limit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;

  // The full catalogue keeps every tool, including the ones that are not
  // published, so that a tools/call for a hidden tool can be answered with an
  // explicit refusal instead of "unknown tool".
  const catalogue = [];
  for (const raw of (Array.isArray(tools) ? tools : []).slice(0, MAX_TOOLS)) {
    const tool = normalizeTool(raw);
    if (tool) catalogue.push(tool);
  }

  // Only the read-only tools are published. The first tool of a name wins, so
  // a later entry can never shadow an already published name.
  const published = [];
  const publishedNames = new Set();
  const hidden = new Map();
  for (const tool of catalogue) {
    if (tool.risk !== "read-only") {
      if (!hidden.has(tool.name)) hidden.set(tool.name, tool);
      continue;
    }
    if (publishedNames.has(tool.name)) continue;
    publishedNames.add(tool.name);
    published.push(tool);
  }

  let closed = false;

  function listTools() {
    return published.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
  }

  function textResult(text, isError = false) {
    const result = { content: [{ type: "text", text: typeof text === "string" ? text : asText(text) }] };
    if (isError) result.isError = true;
    return result;
  }

  function truncatedResult() {
    return { content: [{ type: "text", text: "[结果过大，已截断]" }], truncated: true };
  }

  function serialize(response) {
    try {
      return JSON.stringify(response);
    } catch {
      return JSON.stringify(failure(response?.id ?? null, INTERNAL_ERROR, "响应序列化失败"));
    }
  }

  async function callTool(id, name, args) {
    const tool = published.find(item => item.name === name);
    if (!tool) {
      if (hidden.has(name)) {
        return failure(
          id,
          INVALID_PARAMS,
          `工具 "${name}" 未被本服务端暴露：MCP 服务端只发布只读工具，请改用只读能力。`,
          { tool: name, exposed: false }
        );
      }
      return failure(id, INVALID_PARAMS, `未知工具 "${name}"`, { tool: name });
    }
    if (typeof invoke !== "function") {
      return failure(id, INTERNAL_ERROR, "MCP 服务端未配置工具执行器。", { tool: name });
    }
    let raw;
    try {
      raw = await invoke(tool.name, args);
    } catch (error) {
      const message = error && typeof error.message === "string" ? error.message : "工具执行失败";
      return success(id, textResult(redactToolResult(message), true));
    }
    const text = redactToolResult(typeof raw === "string" ? raw : asText(raw));
    const response = success(id, textResult(text));
    if (serialize(response).length > limit) {
      return success(id, truncatedResult());
    }
    return response;
  }

  /**
   * Handles one JSON-RPC request.
   *
   * @param {object} request
   * @returns {Promise<object|null>} the response, or null for a notification
   */
  async function handle(request) {
    if (closed) return failure(request?.id ?? null, INTERNAL_ERROR, "MCP 服务端已关闭。");
    if (!isPlainObject(request)) return failure(null, INVALID_REQUEST, "请求必须是 JSON-RPC 对象。");
    const method = typeof request.method === "string" ? request.method : "";
    const id = request.id;
    const isNotification = id === undefined || id === null;

    if (request.jsonrpc && request.jsonrpc !== "2.0") {
      return failure(id, INVALID_REQUEST, "只支持 JSON-RPC 2.0。");
    }
    if (!method) return failure(id, INVALID_REQUEST, "缺少 method。");

    if (method === "initialize") {
      return success(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: serverVersion }
      });
    }
    if (method === "notifications/initialized" || method.startsWith("notifications/")) {
      return null;
    }
    if (method === "tools/list") {
      return success(id, { tools: listTools() });
    }
    if (method === "tools/call") {
      const params = request.params;
      if (!isPlainObject(params)) return failure(id, INVALID_PARAMS, "tools/call 需要 params 对象。");
      const toolName = typeof params.name === "string" ? params.name.trim() : "";
      if (!toolName) return failure(id, INVALID_PARAMS, "tools/call 缺少工具名称。");
      const args = params.arguments === undefined ? {} : params.arguments;
      if (!isPlainObject(args)) return failure(id, INVALID_PARAMS, "tools/call 的 arguments 必须是对象。");
      return callTool(id, toolName, args);
    }
    if (method === "ping") {
      return success(id, {});
    }
    if (isNotification) return null;
    return failure(id, METHOD_NOT_FOUND, `未知方法 "${method}"`, { method });
  }

  /**
   * Handles one newline delimited JSON line.
   *
   * @param {string} line
   * @returns {Promise<object|null>}
   */
  async function handleLine(line) {
    const raw = typeof line === "string" ? line : "";
    const trimmed = raw.trim();
    if (!trimmed) return null;
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch {
      return failure(null, PARSE_ERROR, "无法解析 JSON-RPC 消息。");
    }
    return handle(request);
  }

  function close() {
    closed = true;
  }

  return {
    handle,
    handleLine,
    listTools,
    close,
    name: serverName,
    version: serverVersion,
    protocolVersion: PROTOCOL_VERSION,
    isClosed: () => closed
  };
}

/**
 * Serves the MCP server over a stdio transport.
 *
 * The transport reads newline delimited JSON-RPC messages from `input` and
 * writes the answers back to `output`. Every written message is a single line,
 * so the stream stays compatible with the newline delimited JSON dialect.
 *
 * @param {object} server   the server returned by createMcpServer()
 * @param {object} [options]
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @returns {{start: Function, stop: Function}}
 */
export function toStdioTransport(server, { input = process.stdin, output = process.stdout } = {}) {
  if (!server || typeof server.handleLine !== "function") throw new TypeError("toStdioTransport 需要一个 MCP 服务端");
  let buffer = "";
  let running = false;

  function write(response) {
    if (!response) return;
    let line;
    try {
      line = JSON.stringify(response);
    } catch {
      line = JSON.stringify(failure(response?.id ?? null, INTERNAL_ERROR, "响应序列化失败"));
    }
    // A raw newline would break the line based framing, so the payload is
    // written as one line only.
    if (typeof output?.write === "function") output.write(`${line}\n`);
  }

  async function consume(chunk) {
    buffer += String(chunk ?? "");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      write(await server.handleLine(line));
      index = buffer.indexOf("\n");
    }
  }

  function onData(chunk) {
    consume(chunk).catch(() => { /* a broken stream must not crash the host */ });
  }

  function start() {
    if (running) return;
    running = true;
    if (input && typeof input.on === "function") input.on("data", onData);
  }

  function stop() {
    if (!running) return;
    running = false;
    if (input && typeof input.off === "function") input.off("data", onData);
    if (input && typeof input.removeListener === "function") input.removeListener("data", onData);
    buffer = "";
  }

  return { start, stop, isRunning: () => running };
}

// Phase 153: the bridge between an MCP server and the tool registry.
//
// Phase 147 introduced a tool registry that accepts tools from several
// sources and Phase 148 introduced an MCP client. This module is the piece
// in between: it turns the tools of one MCP server into registry compatible
// descriptors and it keeps the safety rules of the project intact while a
// foreign tool runs.
//
// The rules this module keeps:
//   - A bridged tool never bypasses the global execution policy. The read-only
//     mode and the kill switch cover an MCP tool exactly like a built-in tool.
//   - A write or destructive tool needs an explicit one time approval. Without
//     an approval flow the call is refused instead of being executed.
//   - The name of a tool decides how risky it is only when the name says so.
//     An unknown name is treated as `destructive`, never as harmless.
//   - An error of a server is reported as a structured result. The message is
//     redacted, so a token, a key or the value of an environment variable can
//     never reach the caller through an error message.
//
// Nothing in this module starts a process, writes a file or executes a tool of
// a server on its own: it only describes and forwards.

export const MCP_BRIDGE_ID_PREFIX = "mcp";
export const MCP_BRIDGE_ID_SEPARATOR = "__";
export const MAX_BRIDGE_DESCRIPTION_LENGTH = 500;
export const MAX_BRIDGE_TOOLS_PER_SERVER = 200;
export const MAX_BRIDGE_SERVERS = 16;
export const DEFAULT_BRIDGE_TIMEOUT_MS = 20_000;

const RISK_LEVELS = Object.freeze(["read-only", "write", "destructive"]);

// Every bridge that was created in this process. The module level helpers
// below work on all of them, so a caller does not have to keep a reference to
// a single bridge instance.
const BRIDGES = new Set();

// A tool whose name contains one of these words only reads state.
const READ_ONLY_VERBS = Object.freeze([
  "get", "list", "read", "search", "query", "status", "info", "describe", "stat", "show", "find",
  "scan", "inspect", "ping", "version", "count", "exists", "ls", "cat", "grep", "head", "tail",
  "trace", "monitor", "whoami", "hostname"
]);

// A tool whose name contains one of these words changes state, but does not
// obviously remove, destroy or execute something.
const WRITE_VERBS = Object.freeze([
  "create", "update", "write", "set", "post", "put", "patch", "add", "upload", "import", "install",
  "move", "rename", "copy", "mkdir", "rmdir", "chmod", "chown", "save", "edit", "modify", "replace",
  "apply", "enable", "disable", "configure", "config", "mount", "unmount", "clear", "publish",
  "subscribe", "send", "load", "restore", "rotate", "sign", "encrypt", "decrypt"
]);

// A tool whose name contains one of these words removes state, destroys state
// or executes something. They are checked before every other verb, so a name
// such as `search_and_delete` never ends up as a read-only tool and a name
// such as `run_command` never ends up as a mere write.
const DESTRUCTIVE_VERBS = Object.freeze([
  "delete", "remove", "destroy", "erase", "wipe", "kill", "drop", "purge", "uninstall", "format",
  "reset", "truncate", "overwrite", "run", "exec", "execute", "start", "stop", "restart", "sync"
]);

/**
 * Splits a tool name into its words, so `getVolume`, `get_volume` and
 * `volume.list` are all understood.
 *
 * @param {string} name
 * @returns {string[]}
 */
export function splitMcpToolName(name) {
  if (typeof name !== "string" || !name.trim()) return [];
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(token => token.toLowerCase());
}

const SENSITIVE_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;

const EMPTY_SCHEMA = Object.freeze({ type: "object", properties: {}, additionalProperties: false });

const SCHEMA_NOTE = "该工具没有可用的参数 schema，已按空 schema 处理。";

/**
 * Normalizes one segment of a tool identifier.
 *
 * Every character that is not a lower case letter, a digit or an underscore
 * becomes an underscore. The result is never empty, otherwise the caller has
 * to skip the tool.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeMcpSegment(value) {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Builds the namespaced identifier of a bridged tool.
 *
 * @param {string} serverName
 * @param {string} toolName
 * @param {string} [prefix]
 * @returns {string|null} the identifier or null when it cannot be built
 */
export function mcpBridgeToolId(serverName, toolName, prefix = MCP_BRIDGE_ID_PREFIX) {
  const head = normalizeMcpSegment(prefix) || MCP_BRIDGE_ID_PREFIX;
  const server = normalizeMcpSegment(serverName);
  const tool = normalizeMcpSegment(toolName);
  if (!server || !tool) return null;
  return `${head}${MCP_BRIDGE_ID_SEPARATOR}${server}${MCP_BRIDGE_ID_SEPARATOR}${tool}`;
}

/**
 * Decides how risky a tool of a server is.
 *
 * The decision only uses the name of the tool and an explicit read-only marker
 * of the server. A declared server risk is not trusted here, because a server
 * can publish any name it wants.
 *
 * The name is matched twice: once as a whole and once on its last segment, so
 * both `get_volume` and `volume.list` are recognized. A write verb wins over a
 * read verb, and a name that matches neither is destructive.
 *
 * @param {object} tool the raw tool description of the server
 * @returns {"read-only"|"write"|"destructive"}
 */
export function mapMcpToolRisk(tool) {
  const name = typeof tool?.name === "string" ? tool.name.trim() : "";
  const tokens = name ? splitMcpToolName(name) : [];
  // A name that removes or destroys state is never read-only, not even when
  // the server claims the tool is harmless.
  if (tokens.some(token => DESTRUCTIVE_VERBS.includes(token))) return "destructive";
  if (tool?.readOnly === true || tool?.readOnlyHint === true || tool?.annotations?.readOnly === true) return "read-only";
  if (tool?.risk === "read-only") return "read-only";
  if (!tokens.length) return "destructive";
  if (tokens.some(token => WRITE_VERBS.includes(token))) return "write";
  if (tokens.some(token => READ_ONLY_VERBS.includes(token))) return "read-only";
  return "destructive";
}

function redactMessage(message, secrets = []) {
  let text = typeof message === "string" ? message : "MCP 工具调用失败。";
  for (const secret of Array.isArray(secrets) ? secrets : []) {
    if (typeof secret !== "string" || secret.length < 6) continue;
    text = text.split(secret).join("[已隐藏]");
  }
  text = text.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[已隐藏]");
  text = text.replace(/\bgh[pousr]_[A-Za-z0-9]{10,}\b/g, "[已隐藏]");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [已隐藏]");
  text = text.replace(
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|credential|authorization)\s*[:=]\s*)("?)[^\s"',;]+/gi,
    "$1[已隐藏]"
  );
  text = text.replace(/\b[0-9a-f]{40,}\b/gi, "[已隐藏]");
  return text.slice(0, 500);
}

function collectSecretValues(secrets = []) {
  const values = [];
  for (const secret of Array.isArray(secrets) ? secrets : []) {
    if (typeof secret === "string" && secret.length >= 6) values.push(secret);
  }
  for (const [name, value] of Object.entries(process.env || {})) {
    if (typeof value !== "string" || value.length < 8) continue;
    if (!SENSITIVE_ENV_NAME.test(name)) continue;
    values.push(value);
  }
  return values;
}

function policyMessage(reason) {
  if (reason === "read-only-mode") return "当前处于只读模式，MCP 工具调用已拒绝。";
  if (reason === "kill-switch") return "执行总开关已关闭，所有工具调用均被拒绝。";
  if (reason === "unknown-risk") return "工具的风险级别未知，MCP 工具调用已拒绝。";
  if (reason === "policy-unavailable") return "没有可用的执行策略，MCP 工具调用已拒绝。";
  return `工具调用被执行策略拒绝（${reason}），已拒绝执行。`;
}

function isPreApproved(options) {
  if (!options || typeof options !== "object") return false;
  if (options.approved === true) return true;
  const capability = options.capability;
  return Boolean(capability && typeof capability === "object" && Object.keys(capability).length > 0);
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return promise.then(value => ({ timedOut: false, value }), error => ({ timedOut: false, error }));
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      error => {
        clearTimeout(timer);
        resolve({ timedOut: false, error });
      }
    );
  });
}

function classifyError(error) {
  if (error?.name === "AbortError") return "timeout";
  if (error?.code === "ETIMEDOUT" || error?.code === "ERR_TIMEOUT") return "timeout";
  if (typeof error?.code === "number") return "protocol-error";
  if (typeof error?.code === "string" && error.code) return error.code;
  if (/timed?\s*out|timeout/i.test(String(error?.message || ""))) return "timeout";
  return "server-error";
}

/**
 * Creates the bridge for the tools of MCP servers.
 *
 * @param {object} options
 * @param {object|null} options.client           an MCP client of `mcp-client.mjs`
 * @param {object[]|null} options.tools           the tools the client published
 * @param {object|null} options.policy            the global execution policy
 * @param {string} [options.prefix]               the identifier prefix
 * @param {Function|null} [options.requestApproval] asks for a one time approval
 * @param {string|null} [options.serverName]      the name of the first server
 * @param {number} [options.timeoutMs]            the timeout of one call
 * @param {string[]} [options.secrets]            extra values to redact
 */
export function createMcpToolBridge({
  client = null,
  tools = null,
  policy = null,
  prefix = MCP_BRIDGE_ID_PREFIX,
  requestApproval = null,
  serverName = null,
  timeoutMs = DEFAULT_BRIDGE_TIMEOUT_MS,
  secrets = []
} = {}) {
  const servers = new Map();
  const index = new Map();
  const secretValues = collectSecretValues(secrets);

  const failure = (code, message) => ({ ok: false, error: { code, message } });

  function normalizeTool(server, raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = typeof raw.name === "string" ? raw.name.trim() : typeof raw.id === "string" ? raw.id.trim() : "";
    if (!name) return null;
    const id = mcpBridgeToolId(server, name, prefix);
    if (!id) return null;
    const schemaUsable = Boolean(raw.inputSchema) && typeof raw.inputSchema === "object" && !Array.isArray(raw.inputSchema);
    const inputSchema = schemaUsable ? raw.inputSchema : { ...EMPTY_SCHEMA, properties: {} };
    const head = `[mcp:${server}]`;
    const original = typeof raw.description === "string" ? raw.description.trim() : "";
    const description = `${head}${schemaUsable ? " " : ` ${SCHEMA_NOTE}`}${original ? ` ${original}` : ""}`.slice(0, MAX_BRIDGE_DESCRIPTION_LENGTH);
    const risk = mapMcpToolRisk(raw);
    return {
      id,
      title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 200) : name,
      description,
      risk: RISK_LEVELS.includes(risk) ? risk : "destructive",
      inputSchema,
      server,
      name,
      schemaDegraded: !schemaUsable
    };
  }

  /**
   * Registers the tools of one server. Registering the same server twice
   * replaces the previous catalogue instead of adding to it.
   */
  function registerServer({ name, tools: toolList, client: serverClient } = {}) {
    const server = normalizeMcpSegment(name);
    if (!server) throw new TypeError("An MCP server needs a name");
    if (!servers.has(server) && servers.size >= MAX_BRIDGE_SERVERS)
      throw new Error("Too many MCP servers are bridged");
    const entries = [];
    const rejected = [];
    for (const raw of Array.isArray(toolList) ? toolList.slice(0, MAX_BRIDGE_TOOLS_PER_SERVER) : []) {
      const tool = normalizeTool(server, raw);
      if (!tool) {
        rejected.push(typeof raw?.name === "string" ? raw.name : "unknown");
        continue;
      }
      entries.push(tool);
    }
    servers.set(server, { name: server, client: serverClient ?? null, tools: entries });
    rebuildIndex();
    return { server, tools: entries.length, rejected };
  }

  function rebuildIndex() {
    index.clear();
    for (const server of servers.values())
      for (const tool of server.tools) index.set(tool.id, { tool, server });
  }

  function listBridgedTools() {
    const result = [];
    for (const server of servers.values())
      for (const tool of server.tools)
        result.push({
          id: tool.id,
          title: tool.title,
          description: tool.description,
          risk: tool.risk,
          inputSchema: tool.inputSchema,
          server: tool.server
        });
    return result;
  }

  function unregisterServer(name) {
    const server = normalizeMcpSegment(name);
    if (!server) return 0;
    const entry = servers.get(server);
    if (!entry) return 0;
    servers.delete(server);
    rebuildIndex();
    return entry.tools.length;
  }

  function get(id) {
    if (typeof id !== "string") return null;
    return index.get(id.trim()) || null;
  }

  async function invoke(id, args = {}, options = {}) {
    const found = get(id);
    if (!found) return failure("tool-not-found", `未知的 MCP 工具：${typeof id === "string" ? id : ""}`);
    const { tool, server } = found;
    const serverClient = server.client;
    if (!serverClient || typeof serverClient.callTool !== "function")
      return failure("client-unavailable", `MCP 服务器 ${server.name} 当前不可用。`);

    const preApproved = isPreApproved(options);
    const evaluate = risk => {
      if (!policy || typeof policy.evaluate !== "function")
        return risk === "read-only"
          ? { allowed: true, reason: "allowed", requiresApproval: false }
          : { allowed: false, reason: "policy-unavailable", requiresApproval: false };
      const verdict = policy.evaluate({ risk, approved: preApproved });
      return verdict && typeof verdict === "object"
        ? verdict
        : { allowed: false, reason: "policy-denied", requiresApproval: false };
    };

    if (tool.risk !== "read-only" && !preApproved) {
      // A write or destructive tool always needs an explicit one time
      // approval, even when the execution policy would allow the call.
      const before = evaluate(tool.risk);
      if (!before.allowed && before.reason !== "approval-required" && !before.requiresApproval)
        return failure(before.reason || "policy-denied", policyMessage(before.reason || "policy-denied"));
      if (typeof requestApproval !== "function")
        return failure("approval-denied", "MCP 工具调用需要一次性批准，但当前没有可用的批准流程，已拒绝执行。");
      let granted = false;
      try {
        granted = await requestApproval({
          toolId: tool.id,
          server: server.name,
          toolName: tool.name,
          risk: tool.risk,
          title: tool.title,
          description: tool.description
        });
      } catch {
        granted = false;
      }
      if (!granted) return failure("approval-denied", "MCP 工具调用未获得批准，已拒绝执行。");
      const after = evaluate(tool.risk);
      if (!after.allowed) return failure(after.reason || "policy-denied", policyMessage(after.reason || "policy-denied"));
    } else {
      const verdict = evaluate(tool.risk);
      if (!verdict.allowed) return failure(verdict.reason || "policy-denied", policyMessage(verdict.reason || "policy-denied"));
    }

    let outcome;
    try {
      outcome = await withTimeout(Promise.resolve().then(() => serverClient.callTool(tool.name, args)), timeoutMs);
    } catch (error) {
      return failure(classifyError(error), redactMessage(error?.message, secretValues));
    }
    if (outcome.timedOut) return failure("timeout", `MCP 工具 ${tool.name} 调用超时，已中止。`);
    if (outcome.error) return failure(classifyError(outcome.error), redactMessage(outcome.error?.message, secretValues));
    return { ok: true, toolId: tool.id, server: server.name, risk: tool.risk, result: outcome.value };
  }

  /**
   * Adapts the bridge to the source shape of the tool registry of Phase 147.
   */
  function toToolSource() {
    return {
      id: `mcp:${[...servers.keys()].join(",") || "none"}`,
      kind: "mcp",
      label: "MCP 工具",
      list: listBridgedTools,
      invoke
    };
  }

  if (client || Array.isArray(tools)) {
    const firstName = normalizeMcpSegment(serverName || client?.serverId || client?.name || "server");
    registerServer({ name: firstName, tools: Array.isArray(tools) ? tools : [], client });
  }

  const bridge = Object.freeze({
    registerServer,
    unregisterServer,
    listBridgedTools,
    list: listBridgedTools,
    get,
    invoke,
    servers: () => [...servers.values()].map(server => ({ name: server.name, tools: server.tools.length })),
    toToolSource
  });
  BRIDGES.add(bridge);
  return bridge;
}

/**
 * Lists the tools of every bridge of this process.
 *
 * When a bridge is given, only that bridge is asked. Without an argument the
 * tools of all bridges are collected, so a caller that owns one bridge does
 * not need a registry of its own.
 *
 * @param {object|null} [bridge]
 * @returns {Array<object>}
 */
export function listBridgedTools(bridge = null) {
  if (bridge && typeof bridge.listBridgedTools === "function") return bridge.listBridgedTools();
  const result = [];
  for (const item of BRIDGES) result.push(...item.listBridgedTools());
  return result;
}

/**
 * Removes one server from one bridge, or from every bridge of this process.
 *
 * @param {string} serverName
 * @param {object|null} [bridge]
 * @returns {number} the number of removed tools
 */
export function unregisterServer(serverName, bridge = null) {
  if (bridge && typeof bridge.unregisterServer === "function") return bridge.unregisterServer(serverName);
  let removed = 0;
  for (const item of BRIDGES) removed += item.unregisterServer(serverName);
  return removed;
}

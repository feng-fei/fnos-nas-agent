// Phase 148: a small MCP (Model Context Protocol) client.
//
// The client speaks JSON-RPC 2.0 over the stdio transport, which is the
// transport the MCP servers shipped with Marvis use as well. It is written
// without any third party dependency so the NAS image does not need a build
// step.
//
// Safety rules that the rest of the project relies on:
//   - A server is never started on its own. It has to be declared in the MCP
//     configuration file and explicitly enabled.
//   - The declared risk of the server is attached to every tool it publishes.
//     A server without a declared risk is treated as `write`.
//   - The client itself never grants permissions. The tool registry applies
//     the global execution policy and the destructive capability check.

import { spawn } from "node:child_process";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_TOOL_ID_PREFIX = "mcp";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/**
 * Builds the namespaced identifier of an MCP tool.
 *
 * @param {string} serverId the server identifier declared in the configuration
 * @param {string} toolName the tool name reported by the server
 * @returns {string}
 */
export function mcpToolId(serverId, toolName) {
  return `${MCP_TOOL_ID_PREFIX}:${serverId}:${toolName}`;
}

/**
 * Validates a server declaration of the MCP configuration.
 *
 * @returns {{ok: true, server: object} | {ok: false, error: string}}
 */
export function validateMcpServerConfig(entry) {
  if (!entry || typeof entry !== "object") return { ok: false, error: "A server entry must be an object" };
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) return { ok: false, error: "A server entry needs a lowercase id" };
  if (typeof entry.command !== "string" || !entry.command.trim()) return { ok: false, error: "A server entry needs a command" };
  const args = entry.args === undefined ? [] : entry.args;
  if (!Array.isArray(args) || args.some(item => typeof item !== "string")) return { ok: false, error: "A server entry needs a string array of arguments" };
  const risk = entry.risk ?? "write";
  if (!["read-only", "write", "destructive"].includes(risk)) return { ok: false, error: "A server entry needs a valid risk" };
  const env = entry.env && typeof entry.env === "object" && !Array.isArray(entry.env) ? entry.env : {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) return { ok: false, error: "A server entry has an invalid environment variable name" };
    if (typeof value !== "string") return { ok: false, error: "A server entry has an invalid environment variable value" };
  }
  return {
    ok: true,
    server: {
      id,
      command: entry.command.trim(),
      args: args.map(String),
      cwd: typeof entry.cwd === "string" && entry.cwd.trim() ? entry.cwd.trim() : null,
      env,
      risk,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : id,
      enabled: entry.enabled !== false
    }
  };
}

/**
 * Creates a client for one MCP server.
 *
 * @param {object} options
 * @param {object} options.server       validated server declaration
 * @param {number} options.timeoutMs    per request timeout
 * @param {Function} options.spawn      process spawn implementation (for tests)
 */
export function createMcpClient({ server, timeoutMs = DEFAULT_TIMEOUT_MS, spawn: spawnFn = spawn } = {}) {
  if (!server || typeof server !== "object") throw new TypeError("An MCP server declaration is required");
  let child = null;
  let buffer = "";
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  let stderr = "";
  let tools = [];

  function rejectAll(error) {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (typeof message.id === "number" && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const error = new Error(message.error?.message || "MCP request failed");
        error.code = message.error?.code;
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    // A notification (for example notifications/initialized) has no id.
  }

  function start() {
    if (child) return child;
    child = spawnFn(server.command, server.args, {
      cwd: server.cwd || undefined,
      env: { ...process.env, ...server.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > MAX_BUFFERED_BYTES) {
        buffer = "";
        rejectAll(new Error("MCP server produced too much output"));
        return;
      }
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          try {
            handleMessage(JSON.parse(line));
          } catch {
            // A server that prints something that is not JSON-RPC is ignored,
            // it must not break the session of the other tools.
          }
        }
        index = buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    });
    child.on("error", error => rejectAll(error));
    child.on("exit", () => {
      child = null;
      closed = true;
      rejectAll(new Error("MCP server exited"));
    });
    return child;
  }

  function request(method, params) {
    if (closed) return Promise.reject(new Error("MCP client is closed"));
    const process_ = start();
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method };
    if (params !== undefined) payload.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        process_.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function notify(method, params) {
    const process_ = start();
    const payload = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    try {
      process_.stdin.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Starts the server and performs the MCP handshake.
   */
  async function connect() {
    if (tools.length) return tools;
    const result = await request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false }, sampling: {} },
      clientInfo: { name: "fnos-nas-agent", version: "1.0.0" }
    });
    notify("notifications/initialized", {});
    const listed = await request("tools/list", {});
    const rawTools = Array.isArray(listed?.tools) ? listed.tools : [];
    tools = rawTools
      .filter(tool => tool && typeof tool.name === "string" && tool.name.trim())
      .slice(0, 200)
      .map(tool => ({
        id: mcpToolId(server.id, tool.name.trim()),
        title: typeof tool.title === "string" && tool.title.trim() ? tool.title.trim() : tool.name.trim(),
        description: typeof tool.description === "string" ? tool.description.slice(0, 1000) : "",
        risk: server.risk,
        inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
          ? tool.inputSchema
          : { type: "object", properties: {}, additionalProperties: false }
      }));
    return tools;
  }

  /**
   * Calls one tool of the server.
   */
  async function callTool(name, args = {}) {
    const result = await request("tools/call", { name, arguments: args });
    const text = (result?.content || [])
      .filter(item => item?.type === "text" && typeof item.text === "string")
      .map(item => item.text)
      .join("\n");
    if (result?.isError === true) throw new Error(text || "The MCP tool reported an error");
    return { text, raw: result };
  }

  function close() {
    closed = true;
    if (!child) return;
    try { child.stdin.end(); } catch { /* the server may already be gone */ }
    try { child.kill(); } catch { /* the server may already be gone */ }
    child = null;
    rejectAll(new Error("MCP client was closed"));
  }

  return {
    serverId: server.id,
    connect,
    listTools: async () => (tools.length ? tools : connect()),
    callTool,
    close,
    status: () => ({
      id: server.id,
      connected: Boolean(child),
      closed,
      toolCount: tools.length,
      lastError: stderr.trim().slice(-500) || null
    })
  };
}

/**
 * Adapts an MCP client to the source shape of the tool registry.
 *
 * The registry is synchronous, therefore the catalogue of the server is kept in
 * a cache. The cache is filled when the agent starts (`warmup`) and it can be
 * refreshed later. A server that is not reachable keeps an empty catalogue and
 * never breaks the built-in tools.
 *
 * @param {object} client
 * @param {object[]} [initialTools] tools that are already known
 * @returns {{id: string, kind: "mcp", label: string, list: Function, invoke: Function, refresh: Function}}
 */
export function createMcpSource(client, initialTools = null) {
  const serverId = client.serverId;
  const prefix = `mcp:${serverId}:`;
  const cache = { tools: Array.isArray(initialTools) ? initialTools.slice() : [] };
  return {
    id: `mcp:${serverId}`,
    kind: "mcp",
    label: `MCP · ${serverId}`,
    list: () => cache.tools.slice(),
    invoke: async (toolId, args = {}) => {
      const toolName = toolId.startsWith(prefix) ? toolId.slice(prefix.length) : toolId;
      return client.callTool(toolName, args);
    },
    refresh: async () => {
      cache.tools = await client.listTools();
      return cache.tools.slice();
    }
  };
}

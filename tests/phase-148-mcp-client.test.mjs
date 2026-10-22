import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createMcpClient, createMcpSource, mcpToolId, validateMcpServerConfig } from "../apps/fnos-nas-agent/app/mcp-client.mjs";
import { parseMcpConfig, createMcpManager } from "../apps/fnos-nas-agent/app/mcp-servers.mjs";

function createFakeProcess(responder = () => null) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stdout.setEncoding = () => {};
  proc.stderr = new EventEmitter();
  proc.stderr.setEncoding = () => {};
  proc.kill = () => {};
  proc.sent = [];
  proc.stdin = {
    end: () => {},
    write: line => {
      const message = JSON.parse(line);
      proc.sent.push(message);
      const answer = responder(message, proc);
      if (answer !== null && answer !== undefined) {
        queueMicrotask(() => proc.stdout.emit("data", `${JSON.stringify(answer)}\n`));
      }
      return true;
    }
  };
  return proc;
}

/**
 * Builds a fake MCP server process.
 *
 * The options object may carry a `methods` map (method name -> handler) or a
 * `responder` function that receives the JSON-RPC message and the process.
 */
function createFakeSpawn(options = {}) {
  const config = typeof options === "function" ? { responder: options } : options;
  const proc = createFakeProcess((message, process_) => {
    if (typeof config.onNoise === "function") config.onNoise(process_);
    if (typeof config.responder === "function") {
      const answer = config.responder(message, process_);
      if (answer !== null && answer !== undefined) return answer;
    }
    const handler = config.methods?.[message.method];
    if (!handler) return null;
    const result = handler(message.params, message.id);
    if (result === undefined || result === null) return null;
    return result;
  });
  const spawn = () => proc;
  spawn.proc = proc;
  return spawn;
}

function server(overrides = {}) {
  return { id: "nas-tools", command: "/opt/mcp/nas", args: ["--stdio"], risk: "read-only", label: "NAS 工具", env: {}, ...overrides };
}

/**
 * A responder that answers the three methods of the MCP handshake with the
 * identifier of the request.
 */
function handshakeResponder(text = "卷 1") {
  return message => {
    if (message.method === "initialize") return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {} } };
    if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "volume.list", description: "列出存储卷。", inputSchema: { type: "object", properties: {} } }] } };
    if (message.method === "tools/call") return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } };
    return null;
  };
}

test("builds namespaced tool identifiers", () => {
  assert.equal(mcpToolId("nas-tools", "volume.list"), "mcp:nas-tools:volume.list");
});

test("validates a server declaration", () => {
  const ok = validateMcpServerConfig({ id: "nas-tools", command: "/opt/mcp/nas", args: ["--stdio"], risk: "read-only" });
  assert.equal(ok.ok, true);
  assert.equal(ok.server.risk, "read-only");
  assert.equal(validateMcpServerConfig({ id: "Bad Id", command: "x" }).ok, false);
  assert.equal(validateMcpServerConfig({ id: "ok", command: "" }).ok, false);
  assert.equal(validateMcpServerConfig({ id: "ok", command: "x", args: "not-an-array" }).ok, false);
  assert.equal(validateMcpServerConfig({ id: "ok", command: "x", risk: "weird" }).ok, false);
  assert.equal(validateMcpServerConfig({ id: "ok", command: "x", env: { "BAD NAME": "1" } }).ok, false);
});

test("parses the configuration and skips disabled servers", () => {
  const { servers, errors } = parseMcpConfig(JSON.stringify({
    servers: [
      { id: "a", command: "/opt/a", risk: "read-only" },
      { id: "b", command: "/opt/b", enabled: false }
    ]
  }));
  assert.equal(servers.length, 1);
  assert.equal(servers[0].id, "a");
  assert.equal(errors.length, 0);
});

test("a broken configuration file does not throw", () => {
  const broken = parseMcpConfig("{ not json");
  assert.equal(broken.servers.length, 0);
  assert.equal(broken.errors.length, 1);
  const invalidEntry = parseMcpConfig(JSON.stringify({ servers: [{ id: "x" }] }));
  assert.equal(invalidEntry.servers.length, 0);
  assert.equal(invalidEntry.errors.length, 1);
});

test("performs the MCP handshake and lists the tools of the server", async () => {
  const spawn = createFakeSpawn({
    methods: {
      initialize: (_params, id) => ({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: {} } }),
      "tools/list": (_params, id) => ({ jsonrpc: "2.0", id, result: { tools: [{ name: "volume.list", description: "列出存储卷。", inputSchema: { type: "object", properties: {} } }] } })
    }
  });
  const client = createMcpClient({ server: server(), spawn });
  const tools = await client.connect();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].id, "mcp:nas-tools:volume.list");
  assert.equal(tools[0].risk, "read-only");
  const methods = spawn.proc.sent.map(message => message.method);
  assert.ok(methods.includes("initialize"));
  assert.ok(methods.includes("notifications/initialized"));
  assert.ok(methods.includes("tools/list"));
});

test("calls a tool and returns its text content", async () => {
  const spawn = createFakeSpawn(handshakeResponder("卷 1"));
  const client = createMcpClient({ server: server(), spawn });
  await client.connect();
  const result = await client.callTool("volume.list", { a: 1 });
  assert.equal(result.text, "卷 1");
});

test("an error result of the server becomes an error", async () => {
  const spawn = createFakeSpawn(message => {
    if (message.method === "initialize") return { jsonrpc: "2.0", id: message.id, result: {} };
    if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id, result: { tools: [] } };
    if (message.method === "tools/call") return { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Invalid params" } };
    return null;
  });
  const client = createMcpClient({ server: server(), spawn });
  await client.connect();
  await assert.rejects(() => client.callTool("volume.list", {}), /Invalid params/);
});

test("noise on the standard output does not break the client", async () => {
  const spawn = createFakeSpawn({
    onNoise: process_ => { process_.stdout.emit("data", "not json at all\n"); },
    responder: handshakeResponder()
  });
  const client = createMcpClient({ server: server(), spawn });
  const tools = await client.connect();
  assert.equal(tools.length, 1);
});

test("a request that is never answered times out", async () => {
  const spawn = createFakeSpawn(() => null);
  const client = createMcpClient({ server: server(), timeoutMs: 30, spawn });
  await assert.rejects(() => client.connect(), /timed out/);
  client.close();
});

test("adapts a client to a tool registry source", async () => {
  const spawn = createFakeSpawn(handshakeResponder("ok"));
  const client = createMcpClient({ server: server(), spawn });
  const tools = await client.listTools();
  const source = createMcpSource(client, tools);
  assert.equal(source.kind, "mcp");
  assert.equal(source.list().length, 1);
  assert.equal(source.list()[0].id, "mcp:nas-tools:volume.list");
  const result = await source.invoke("mcp:nas-tools:volume.list", {});
  assert.equal(result.text, "ok");
});

test("the manager keeps a failing server from breaking the others", async () => {
  const good = createFakeSpawn(handshakeResponder());
  const manager = createMcpManager({
    servers: [
      { id: "good", command: "/opt/good", args: [], risk: "read-only" },
      { id: "bad", command: "/opt/bad", args: [], risk: "read-only" }
    ],
    spawn: command => (command === "/opt/good" ? good() : createFakeProcess()),
    timeoutMs: 100
  });
  const tools = await manager.list();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].id, "mcp:good:volume.list");
  assert.ok(manager.status().errors.length >= 1);
  manager.stopAll();
});

test("the manager warms up and exposes the sources of the registry", async () => {
  const good = createFakeSpawn(handshakeResponder());
  const manager = createMcpManager({
    servers: [{ id: "good", command: "/opt/good", args: [], risk: "read-only" }],
    spawn: () => good()
  });
  const status = await manager.warmup();
  assert.equal(status.servers.length, 1);
  const sources = manager.sources();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, "mcp:good");
  assert.equal(sources[0].kind, "mcp");
  manager.stopAll();
});

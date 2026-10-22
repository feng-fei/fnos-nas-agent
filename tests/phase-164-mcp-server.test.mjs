import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  createMcpServer,
  toStdioTransport,
  redactToolResult,
  externalToolName,
  maskSecret
} from "../apps/fnos-nas-agent/app/mcp-server.mjs";

const READ_ONLY_TOOLS = [
  {
    id: "files.list",
    name: "files_list",
    title: "浏览文件目录",
    description: "列出允许存储卷中的目录和文件元数据。",
    risk: "read-only",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false }
  },
  {
    id: "system.status",
    name: "system_status",
    description: "读取 NAS 运行状态。",
    risk: "read-only",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

const MUTATING_TOOLS = [
  {
    id: "files.create-folder",
    name: "files_create_folder",
    description: "创建文件夹。",
    risk: "write",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false }
  },
  {
    id: "files.delete",
    name: "files_delete",
    description: "删除文件。",
    risk: "destructive",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false }
  }
];

function createServer(overrides = {}) {
  const calls = [];
  const server = createMcpServer({
    name: "fnos-nas-agent",
    version: "1.0.0",
    tools: [...READ_ONLY_TOOLS, ...MUTATING_TOOLS],
    invoke: async (toolName, args) => {
      calls.push({ toolName, args });
      return `${toolName}:${JSON.stringify(args ?? {})}`;
    },
    ...overrides
  });
  return { server, calls };
}

test("initialize reports the protocol version, the server info and the tool capability", async () => {
  const { server } = createServer();
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, "2024-11-05");
  assert.deepEqual(response.result.serverInfo, { name: "fnos-nas-agent", version: "1.0.0" });
  assert.deepEqual(response.result.capabilities, { tools: {} });
});

test("notifications/initialized is answered with null so the client sees no reply", async () => {
  const { server } = createServer();
  const response = await server.handle({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  assert.equal(response, null);
});

test("tools/list publishes only the read-only tools", async () => {
  const { server } = createServer();
  const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = response.result.tools.map(tool => tool.name);
  assert.deepEqual(names, ["files_list", "system_status"]);
  assert.ok(!names.includes("files_create_folder"));
  assert.ok(!names.includes("files_delete"));
  assert.equal(response.result.tools[0].description, "列出允许存储卷中的目录和文件元数据。");
  assert.equal(response.result.tools[0].inputSchema.type, "object");
});

test("tools/call runs a read-only tool and returns a text content block", async () => {
  const { server, calls } = createServer();
  const response = await server.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "files_list", arguments: { path: "/data" } }
  });
  assert.equal(response.id, 3);
  assert.equal(response.result.content[0].type, "text");
  assert.match(response.result.content[0].text, /files_list/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { path: "/data" });
});

test("tools/call on a write tool is refused and the tool never runs", async () => {
  const { server, calls } = createServer();
  const response = await server.handle({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "files_create_folder", arguments: { path: "/data" } }
  });
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /未被本服务端暴露/);
  assert.equal(calls.length, 0);
});

test("tools/call on a destructive tool is refused as well", async () => {
  const { server, calls } = createServer();
  const response = await server.handle({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "files_delete", arguments: { path: "/data/a.txt" } }
  });
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /只发布只读工具/);
  assert.equal(calls.length, 0);
});

test("an unknown method is answered with -32601", async () => {
  const { server } = createServer();
  const response = await server.handle({ jsonrpc: "2.0", id: 6, method: "resources/list" });
  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /未知方法/);
});

test("a broken JSON line is answered with -32700", async () => {
  const { server } = createServer();
  const response = await server.handleLine("{not json");
  assert.equal(response.error.code, -32700);
});

test("a malformed tools/call request is answered with -32602", async () => {
  const { server } = createServer();
  const missingName = await server.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {} });
  assert.equal(missingName.error.code, -32602);
  const badArgs = await server.handle({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "files_list", arguments: "not-an-object" }
  });
  assert.equal(badArgs.error.code, -32602);
});

test("an oversized result is truncated instead of being sent", async () => {
  const { server } = createServer({
    maxBytes: 512,
    invoke: async () => "x".repeat(4096)
  });
  const response = await server.handle({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "system_status", arguments: {} }
  });
  assert.equal(response.result.truncated, true);
  assert.equal(response.result.content[0].text, "[结果过大，已截断]");
});

test("a failing tool is reported as a tool error, not as a transport error", async () => {
  const { server } = createServer({
    invoke: async () => { throw new Error("存储卷不可用"); }
  });
  const response = await server.handle({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "system_status", arguments: {} }
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /存储卷不可用/);
});

test("redactToolResult masks a secret but keeps the surrounding text", () => {
  const masked = redactToolResult("调用失败：api_key=sk-abcdef1234567890");
  assert.ok(!masked.includes("abcdef1234567890"));
  assert.match(masked, /调用失败/);
  assert.match(masked, /sk\*\*/);
});

test("redactToolResult masks a bearer token and a JSON style secret", () => {
  const masked = redactToolResult('Authorization: Bearer aVeryLongTokenValue {"password":"SuperSecretValue"}');
  assert.ok(!masked.includes("aVeryLongTokenValue"));
  assert.ok(!masked.includes("SuperSecretValue"));
});

test("redactToolResult leaves an ordinary result untouched", () => {
  const text = "共 12 个文件，占用 3.2 GiB。";
  assert.equal(redactToolResult(text), text);
});

test("a tool result that contains a secret is masked before it leaves the server", async () => {
  const { server } = createServer({
    invoke: async () => "apiKey=sk-live-0000111122223333"
  });
  const response = await server.handle({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: { name: "system_status", arguments: {} }
  });
  assert.ok(!response.result.content[0].text.includes("0000111122223333"));
});

test("maskSecret keeps only the first two characters", () => {
  assert.equal(maskSecret("abcdefgh"), "ab********");
  assert.equal(maskSecret(""), "");
});

test("externalToolName rewrites the internal identifier and keeps a declared name", () => {
  assert.equal(externalToolName({ id: "files.list" }), "files_list");
  assert.equal(externalToolName({ name: "files_list" }), "files_list");
  assert.equal(externalToolName({}), "");
});

test("the server refuses to expose a tool whose risk is unknown", async () => {
  const { server } = createServer({
    tools: [{ id: "mystery.tool", name: "mystery_tool", risk: "unknown-level" }]
  });
  const listed = await server.handle({ jsonrpc: "2.0", id: 12, method: "tools/list" });
  assert.deepEqual(listed.result.tools, []);
  const called = await server.handle({
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: { name: "mystery_tool", arguments: {} }
  });
  assert.equal(called.error.code, -32602);
});

test("the server never approves a call on behalf of the client", async () => {
  const { server, calls } = createServer();
  const response = await server.handle({
    jsonrpc: "2.0",
    id: 14,
    method: "tools/call",
    params: { name: "files_delete", arguments: { path: "/data/a.txt" }, approved: true, capability: true }
  });
  assert.equal(response.error.code, -32602);
  assert.equal(calls.length, 0);
});

test("the stdio transport answers every line with a single line of JSON", async () => {
  const { server } = createServer();
  const input = new EventEmitter();
  const written = [];
  const output = { write: chunk => written.push(chunk) };
  const transport = toStdioTransport(server, { input, output });
  transport.start();
  input.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
  input.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  await new Promise(resolve => setImmediate(resolve));
  transport.stop();
  assert.equal(written.length, 2);
  for (const chunk of written) {
    assert.ok(chunk.endsWith("\n"));
    assert.equal(chunk.slice(0, -1).includes("\n"), false);
    JSON.parse(chunk);
  }
});

test("the stdio transport refuses a broken line with a parse error", async () => {
  const { server } = createServer();
  const input = new EventEmitter();
  const written = [];
  const transport = toStdioTransport(server, { input, output: { write: chunk => written.push(chunk) } });
  transport.start();
  input.emit("data", "not-json\n");
  await new Promise(resolve => setImmediate(resolve));
  transport.stop();
  assert.equal(written.length, 1);
  assert.equal(JSON.parse(written[0]).error.code, -32700);
});

test("a closed server refuses further requests", async () => {
  const { server } = createServer();
  server.close();
  const response = await server.handle({ jsonrpc: "2.0", id: 15, method: "tools/list" });
  assert.equal(response.error.code, -32603);
});

test("listTools mirrors tools/list", async () => {
  const { server } = createServer();
  const listed = await server.handle({ jsonrpc: "2.0", id: 16, method: "tools/list" });
  assert.deepEqual(server.listTools(), listed.result.tools);
});

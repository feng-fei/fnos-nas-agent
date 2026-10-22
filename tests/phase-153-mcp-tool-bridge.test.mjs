import test from "node:test";
import assert from "node:assert/strict";
import {
  createMcpToolBridge,
  listBridgedTools,
  unregisterServer,
  mapMcpToolRisk,
  mcpBridgeToolId,
  normalizeMcpSegment,
  splitMcpToolName,
  MCP_BRIDGE_ID_PREFIX,
  MCP_BRIDGE_ID_SEPARATOR,
  MAX_BRIDGE_DESCRIPTION_LENGTH,
  MAX_BRIDGE_TOOLS_PER_SERVER,
  MAX_BRIDGE_SERVERS,
  DEFAULT_BRIDGE_TIMEOUT_MS
} from "../apps/fnos-nas-agent/app/mcp-tool-bridge.mjs";

/**
 * A policy that behaves like the execution policy of the project: read-only
 * is allowed, write is allowed in the normal mode and destructive needs an
 * approval.
 */
function createPolicy({ mode = "normal" } = {}) {
  return {
    evaluate({ risk, approved } = {}) {
      if (!["read-only", "write", "destructive"].includes(risk)) return { allowed: false, reason: "unknown-risk", statusCode: 403 };
      if (mode === "halted") return { allowed: false, reason: "kill-switch", statusCode: 503 };
      if (mode === "read-only") {
        if (risk === "read-only") return { allowed: true, reason: "allowed", statusCode: 200 };
        return { allowed: false, reason: "read-only-mode", statusCode: 403 };
      }
      if (risk === "read-only" || risk === "write") return { allowed: true, reason: "allowed", statusCode: 200 };
      return approved === true
        ? { allowed: true, reason: "allowed", statusCode: 200 }
        : { allowed: false, reason: "approval-required", requiresApproval: true, statusCode: 409 };
    }
  };
}

function createClient(overrides = {}) {
  return {
    serverId: "nas",
    callTool: async (name, args = {}) => ({ text: `called ${name}`, args }),
    ...overrides
  };
}

const TOOLS = [
  { name: "list_volumes", description: "列出存储卷。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "getVolume", description: "读取一个存储卷。", inputSchema: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false } },
  { name: "create_snapshot", description: "创建快照。", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
  { name: "delete_snapshot", description: "删除快照。", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } }
];

test("builds a namespaced identifier and normalizes illegal characters", () => {
  assert.equal(mcpBridgeToolId("nas", "list_volumes"), "mcp__nas__list_volumes");
  assert.equal(mcpBridgeToolId("NAS Tools", "get volume"), "mcp__nas_tools__get_volume");
  assert.equal(mcpBridgeToolId("nas", "get/volume"), "mcp__nas__get_volume");
  assert.equal(mcpBridgeToolId("nas", "***"), null);
  assert.equal(mcpBridgeToolId("", "list"), null);
  assert.equal(normalizeMcpSegment("  Mixed Case  "), "mixed_case");
  assert.equal(normalizeMcpSegment("---"), "");
  assert.equal(MCP_BRIDGE_ID_PREFIX, "mcp");
  assert.equal(MCP_BRIDGE_ID_SEPARATOR, "__");
});

test("splits a tool name into its words", () => {
  assert.deepEqual(splitMcpToolName("getVolume"), ["get", "volume"]);
  assert.deepEqual(splitMcpToolName("volume.list"), ["volume", "list"]);
  assert.deepEqual(splitMcpToolName("list_volumes"), ["list", "volumes"]);
  assert.deepEqual(splitMcpToolName(""), []);
});

test("maps the risk of a tool from its name and never trusts an unknown name", () => {
  assert.equal(mapMcpToolRisk({ name: "list_volumes" }), "read-only");
  assert.equal(mapMcpToolRisk({ name: "getVolume" }), "read-only");
  assert.equal(mapMcpToolRisk({ name: "search_content" }), "read-only");
  assert.equal(mapMcpToolRisk({ name: "status" }), "read-only");
  assert.equal(mapMcpToolRisk({ name: "create_snapshot" }), "write");
  assert.equal(mapMcpToolRisk({ name: "updateVolume" }), "write");
  assert.equal(mapMcpToolRisk({ name: "set_status" }), "write");
  assert.equal(mapMcpToolRisk({ name: "delete_snapshot" }), "destructive");
  assert.equal(mapMcpToolRisk({ name: "search_and_delete" }), "destructive");
  assert.equal(mapMcpToolRisk({ name: "run_command" }), "destructive");
  // An unknown name is never harmless.
  assert.equal(mapMcpToolRisk({ name: "wibble" }), "destructive");
  assert.equal(mapMcpToolRisk({ name: "" }), "destructive");
  // A server may declare a tool as read-only.
  assert.equal(mapMcpToolRisk({ name: "wibble", readOnly: true }), "read-only");
  assert.equal(mapMcpToolRisk({ name: "wibble", annotations: { readOnly: true } }), "read-only");
  // A destructive name stays destructive even when the server claims otherwise.
  assert.equal(mapMcpToolRisk({ name: "delete_snapshot", readOnly: true }), "destructive");
});

test("lists the bridged tools with a namespaced identifier and a marked description", () => {
  const bridge = createMcpToolBridge({ client: createClient(), tools: TOOLS, policy: createPolicy() });
  const tools = bridge.listBridgedTools();
  assert.equal(tools.length, 4);
  const list = tools.find(tool => tool.id === "mcp__nas__list_volumes");
  assert.ok(list);
  assert.equal(list.risk, "read-only");
  assert.equal(list.server, "nas");
  assert.ok(list.description.startsWith("[mcp:nas]"));
  assert.equal(bridge.get("mcp__nas__list_volumes").tool.name, "list_volumes");
});

test("truncates a long description to the declared limit", () => {
  const bridge = createMcpToolBridge({
    client: createClient(),
    tools: [{ name: "list_volumes", description: "x".repeat(2000) }],
    policy: createPolicy()
  });
  const [tool] = bridge.listBridgedTools();
  assert.equal(tool.description.length, MAX_BRIDGE_DESCRIPTION_LENGTH);
});

test("degrades an unusable schema and says so in the description", () => {
  const bridge = createMcpToolBridge({
    client: createClient(),
    tools: [{ name: "list_volumes", description: "列出存储卷。", inputSchema: "not-a-schema" }],
    policy: createPolicy()
  });
  const [tool] = bridge.listBridgedTools();
  assert.deepEqual(tool.inputSchema, { type: "object", properties: {}, additionalProperties: false });
  assert.ok(tool.description.includes("没有可用的参数 schema"));
});

test("skips a tool whose name cannot be normalized", () => {
  const bridge = createMcpToolBridge({
    client: createClient(),
    tools: [{ name: "***" }, { name: "list_volumes" }],
    policy: createPolicy()
  });
  assert.equal(bridge.listBridgedTools().length, 1);
  assert.deepEqual(bridge.registerServer({ name: "nas", tools: [{ name: "***" }] }).rejected, ["***"]);
});

test("registers a server again without stacking the tools", () => {
  const bridge = createMcpToolBridge({ policy: createPolicy() });
  bridge.registerServer({ name: "nas", tools: TOOLS, client: createClient() });
  const first = bridge.listBridgedTools().length;
  bridge.registerServer({ name: "nas", tools: TOOLS, client: createClient() });
  assert.equal(bridge.listBridgedTools().length, first);
  assert.equal(bridge.servers().length, 1);
});

test("removes a server and its tools again", () => {
  const bridge = createMcpToolBridge({ policy: createPolicy() });
  bridge.registerServer({ name: "nas", tools: TOOLS, client: createClient() });
  assert.equal(bridge.unregisterServer("nas"), 4);
  assert.equal(bridge.listBridgedTools().length, 0);
  assert.equal(bridge.unregisterServer("nas"), 0);
});

test("refuses too many servers and too many tools of one server", () => {
  const bridge = createMcpToolBridge({ policy: createPolicy() });
  for (let index = 0; index < MAX_BRIDGE_SERVERS; index += 1)
    bridge.registerServer({ name: `server-${index}`, tools: [], client: createClient() });
  assert.throws(() => bridge.registerServer({ name: "one-too-many", tools: [] }), /Too many MCP servers/);

  const other = createMcpToolBridge({ policy: createPolicy() });
  const many = Array.from({ length: MAX_BRIDGE_TOOLS_PER_SERVER + 10 }, (_value, index) => ({ name: `tool_${index}` }));
  const result = other.registerServer({ name: "nas", tools: many, client: createClient() });
  assert.equal(result.tools, MAX_BRIDGE_TOOLS_PER_SERVER);
  assert.equal(other.listBridgedTools().length, MAX_BRIDGE_TOOLS_PER_SERVER);
});

test("invokes a read-only tool without an approval", async () => {
  const bridge = createMcpToolBridge({ client: createClient(), tools: TOOLS, policy: createPolicy() });
  const result = await bridge.invoke("mcp__nas__list_volumes", { any: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.risk, "read-only");
  assert.equal(result.result.text, "called list_volumes");
});

test("needs an approval for a write tool and refuses without an approval flow", async () => {
  const bridge = createMcpToolBridge({ client: createClient(), tools: TOOLS, policy: createPolicy() });
  const denied = await bridge.invoke("mcp__nas__create_snapshot", { id: "a" });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "approval-denied");

  const asked = [];
  const approved = createMcpToolBridge({
    client: createClient(),
    tools: TOOLS,
    policy: createPolicy(),
    requestApproval: async request => {
      asked.push(request);
      return true;
    }
  });
  const result = await approved.invoke("mcp__nas__create_snapshot", { id: "a" });
  assert.equal(result.ok, true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].toolId, "mcp__nas__create_snapshot");
  assert.equal(asked[0].risk, "write");
});

test("needs an approval for a destructive tool", async () => {
  const bridge = createMcpToolBridge({
    client: createClient(),
    tools: TOOLS,
    policy: createPolicy(),
    requestApproval: async () => false
  });
  const result = await bridge.invoke("mcp__nas__delete_snapshot", { id: "a" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "approval-denied");
});

test("honours the read-only mode and the kill switch of the policy", async () => {
  const readOnly = createMcpToolBridge({ client: createClient(), tools: TOOLS, policy: createPolicy({ mode: "read-only" }) });
  const blocked = await readOnly.invoke("mcp__nas__create_snapshot", { id: "a" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "read-only-mode");

  const halted = createMcpToolBridge({ client: createClient(), tools: TOOLS, policy: createPolicy({ mode: "halted" }) });
  const stopped = await halted.invoke("mcp__nas__list_volumes", {});
  assert.equal(stopped.ok, false);
  assert.equal(stopped.error.code, "kill-switch");
});

test("refuses the call when no policy is available and the tool is not read-only", async () => {
  const bridge = createMcpToolBridge({ client: createClient(), tools: TOOLS, requestApproval: async () => true });
  const result = await bridge.invoke("mcp__nas__create_snapshot", { id: "a" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "policy-unavailable");
});

test("reports an unknown tool and a missing client as a structured failure", async () => {
  const bridge = createMcpToolBridge({ client: createClient(), tools: TOOLS, policy: createPolicy() });
  const unknown = await bridge.invoke("mcp__nas__nope", {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "tool-not-found");

  const detached = createMcpToolBridge({ policy: createPolicy() });
  detached.registerServer({ name: "nas", tools: TOOLS, client: null });
  const missing = await detached.invoke("mcp__nas__list_volumes", {});
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "client-unavailable");
});

test("turns a timeout of a server into a structured failure", async () => {
  const bridge = createMcpToolBridge({
    client: createClient({ callTool: () => new Promise(() => {}) }),
    tools: TOOLS,
    policy: createPolicy(),
    timeoutMs: 20
  });
  const result = await bridge.invoke("mcp__nas__list_volumes", {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "timeout");
});

test("turns a protocol error of a server into a structured failure", async () => {
  const bridge = createMcpToolBridge({
    client: createClient({
      callTool: async () => {
        const error = new Error("the server sent an invalid frame");
        error.code = -32700;
        throw error;
      }
    }),
    tools: TOOLS,
    policy: createPolicy()
  });
  const result = await bridge.invoke("mcp__nas__list_volumes", {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "protocol-error");
  assert.equal(result.error.message.includes("invalid frame"), true);
});

test("never lets a token or a secret reach the caller through an error message", async () => {
  const bridge = createMcpToolBridge({
    client: createClient({
      callTool: async () => {
        throw new Error("call failed with Bearer abcdefghijklmnop and api_key=supersecretvalue");
      }
    }),
    tools: TOOLS,
    policy: createPolicy(),
    secrets: ["topsecretvalue"]
  });
  const result = await bridge.invoke("mcp__nas__list_volumes", {});
  assert.equal(result.ok, false);
  assert.equal(result.error.message.includes("abcdefghijklmnop"), false);
  assert.equal(result.error.message.includes("supersecretvalue"), false);
  assert.equal(result.error.message.includes("topsecretvalue"), false);
  assert.ok(result.error.message.includes("已隐藏"));
});

test("exposes the module level helpers for every bridge", () => {
  const bridge = createMcpToolBridge({ policy: createPolicy() });
  bridge.registerServer({ name: "module-level", tools: TOOLS, client: createClient() });
  const listed = listBridgedTools(bridge);
  assert.equal(listed.length, 4);
  assert.equal(listBridgedTools().length >= 4, true);
  assert.equal(unregisterServer("module-level", bridge), 4);
});

test("adapts itself to the shape of a tool source", () => {
  const bridge = createMcpToolBridge({ client: createClient(), tools: TOOLS, policy: createPolicy() });
  const source = bridge.toToolSource();
  assert.equal(source.kind, "mcp");
  assert.equal(typeof source.list, "function");
  assert.equal(typeof source.invoke, "function");
  assert.equal(source.list().length, 4);
});

test("uses the documented default timeout", () => {
  assert.equal(DEFAULT_BRIDGE_TIMEOUT_MS, 20_000);
});

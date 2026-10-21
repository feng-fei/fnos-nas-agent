import test from "node:test";
import assert from "node:assert/strict";
import { createAgentCore } from "../apps/fnos-nas-agent/app/agent-core.mjs";
import { createModelAdapter, modelConfiguration } from "../apps/fnos-nas-agent/app/model-adapter.mjs";

function fixture({ enabled = false, plan = null } = {}) {
  const calls = [];
  const tools = {
    list: () => [
      { id: "system.status", title: "系统状态", description: "只读", risk: "read-only", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      { id: "storage.summary", title: "存储概况", description: "只读", risk: "read-only", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      { id: "files.list", title: "浏览文件目录", description: "只读", risk: "read-only", inputSchema: { type: "object", properties: { path: { type: "string", maxLength: 2048 }, limit: { type: "integer", minimum: 1, maximum: 200 } }, additionalProperties: false } },
      { id: "fnos.photos.folders", title: "相册文件夹", description: "只读", risk: "read-only", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      { id: "fnos.photos.search", title: "相册搜索", description: "只读", risk: "read-only", inputSchema: { type: "object", properties: { keyword: { type: "string", minLength: 1, maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["keyword"], additionalProperties: false } }
    ],
    async invoke(id, args) {
      calls.push({ id, args });
      if (!["system.status", "storage.summary", "files.list", "fnos.photos.folders", "fnos.photos.search"].includes(id)) throw Object.assign(new Error("Unknown tool"), { statusCode: 404 });
      if (id === "files.list" ? Object.keys(args).some(k => !["path", "limit"].includes(k)) : id === "fnos.photos.search" ? typeof args.keyword !== "string" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50 : id === "fnos.photos.folders" ? Object.keys(args).length > 0 : Object.keys(args).length) throw Object.assign(new Error("Invalid args"), { statusCode: 400 });
      return { ok: true, id };
    }
  };
  const model = {
    status: () => ({ enabled }),
    async plan() { return plan; }
  };
  return { agent: createAgentCore({ tools, model, now: () => "2026-10-21T00:00:00.000Z", id: () => "task-test" }), calls };
}

test("rules-first router answers direct NAS queries without model calls", async () => {
  const f = fixture();
  const result = await f.agent.run({ text: "查看系统状态" });
  assert.equal(result.mode, "rules");
  assert.equal(result.status, "completed");
  assert.deepEqual(f.calls, [{ id: "system.status", args: {} }]);
});

test("common storage query routes to the allowlisted storage tool", async () => {
  const f = fixture();
  const result = await f.agent.run({ text: "磁盘空间" });
  assert.equal(result.results[0].tool, "storage.summary");
});


test("direct photo queries route to bounded read-only tools without a model", async () => {
  const f = fixture();
  const folders = await f.agent.run({ text: "查看相册文件夹" });
  assert.equal(folders.results[0].tool, "fnos.photos.folders");
  const search = await f.agent.run({ text: "搜索照片 家庭旅行" });
  assert.equal(search.results[0].tool, "fnos.photos.search");
  assert.deepEqual(f.calls, [
    { id: "fnos.photos.folders", args: {} },
    { id: "fnos.photos.search", args: { keyword: "家庭旅行", limit: 20 } }
  ]);
});

test("unconfigured model safely declines ambiguous requests without tool calls", async () => {
  const f = fixture();
  const result = await f.agent.run({ text: "帮我分析一下 NAS" });
  assert.equal(result.mode, "rules");
  assert.equal(result.results.length, 0);
  assert.equal(f.calls.length, 0);
});

test("model plans can invoke only registered tools with empty args", async () => {
  const f = fixture({ enabled: true, plan: { message: "读取完成", toolCalls: [{ id: "system.status", args: {} }] } });
  const result = await f.agent.run({ text: "帮我看看状态" });
  assert.equal(result.mode, "model");
  assert.equal(result.results[0].tool, "system.status");
});

test("model plans can use validated arguments for scoped read-only tools", async () => {
  const f = fixture({ enabled: true, plan: { message: "正在浏览", toolCalls: [{ id: "files.list", args: { path: "/vol1", limit: 10 } }] } });
  const result = await f.agent.run({ text: "请帮我浏览 /vol1 下的目录" });
  assert.equal(result.status, "completed");
  assert.deepEqual(f.calls, [{ id: "files.list", args: { path: "/vol1", limit: 10 } }]);
});

test("direct file-list questions use the local tool without model configuration", async () => {
  const f = fixture();
  const result = await f.agent.run({ text: "列出文件" });
  assert.equal(result.mode, "rules");
  assert.equal(result.results[0].tool, "files.list");
});

test("unknown tool proposed by model is rejected without arbitrary execution", async () => {
  const f = fixture({ enabled: true, plan: { message: "执行", toolCalls: [{ id: "shell.exec", args: {} }] } });
  const result = await f.agent.run({ text: "运行命令" });
  assert.equal(result.status, "failed");
  assert.equal(f.calls.length, 0);
  assert.equal(result.results.length, 0);
});

test("agent validates empty and oversized messages", async () => {
  const f = fixture();
  await assert.rejects(f.agent.run({ text: "  " }), { statusCode: 400 });
  await assert.rejects(f.agent.run({ text: "x".repeat(2001) }), { statusCode: 400 });
  await assert.rejects(f.agent.run({}), { statusCode: 400 });
});

test("model configuration never enables HTTP endpoints or missing secrets", () => {
  assert.equal(modelConfiguration({ AGENT_MODEL_ENABLED: "true", AGENT_MODEL_ENDPOINT: "http://example.com", AGENT_MODEL_API_KEY: "secret", AGENT_MODEL_NAME: "model" }).enabled, false);
  assert.equal(modelConfiguration({ AGENT_MODEL_ENABLED: "true", AGENT_MODEL_ENDPOINT: "https://example.com/v1/chat/completions", AGENT_MODEL_NAME: "model" }).enabled, false);
  assert.equal(modelConfiguration({ AGENT_MODEL_ENABLED: "true", AGENT_MODEL_ENDPOINT: "https://example.com/v1/chat/completions", AGENT_MODEL_API_KEY: "secret", AGENT_MODEL_NAME: "model" }).enabled, true);
});

test("model adapter parses bounded OpenAI-compatible JSON plans", async () => {
  const adapter = createModelAdapter({
    config: { enabled: true, endpoint: "https://provider.invalid/v1/chat/completions", apiKey: "secret", model: "test", timeoutMs: 1000 },
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.authorization, "Bearer secret");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ message: "已分析", toolCalls: [{ id: "system.status", args: {} }] }) } }] }), { status: 200 });
    }
  });
  const plan = await adapter.plan("查看状态", [{ id: "system.status", title: "系统状态", description: "只读", inputSchema: { type: "object" } }]);
  assert.equal(plan.message, "已分析");
  assert.deepEqual(plan.toolCalls, [{ id: "system.status", args: {} }]);
});

test("model adapter rejects malformed tool arguments and hides provider error details", async () => {
  const adapter = createModelAdapter({
    config: { enabled: true, endpoint: "https://provider.invalid/v1/chat/completions", apiKey: "secret", model: "test", timeoutMs: 1000 },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ message: "x", toolCalls: [{ id: "system.status", args: { command: "id" } }] }) } }] }), { status: 200 })
  });
  await assert.rejects(adapter.plan("test", []), { code: "MODEL_INVALID_PLAN" });
});

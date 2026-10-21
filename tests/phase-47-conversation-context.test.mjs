import test from "node:test";
import assert from "node:assert/strict";
import { createAgentCore } from "../apps/fnos-nas-agent/app/agent-core.mjs";
import { createModelAdapter } from "../apps/fnos-nas-agent/app/model-adapter.mjs";

const tools = [{
  id: "system.status",
  title: "系统状态",
  description: "读取 NAS 系统状态。",
  risk: "read-only",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }
}];

function envelope(plan) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(plan) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  }), { status: 200 });
}

test("agent forwards validated prior turns to model planning without changing direct rule routing", async () => {
  let captured = null;
  const core = createAgentCore({
    tools: {
      list: () => tools,
      invoke: async () => ({ ok: true })
    },
    model: {
      status: () => ({ enabled: true }),
      async plan(text, catalogue, history) {
        captured = { text, catalogue, history };
        return { message: "我会结合前文继续处理。", toolCalls: [] };
      }
    },
    id: () => "phase47-task"
  });
  const history = [
    { role: "user", content: "查看 /vol1/资料" },
    { role: "assistant", content: "目录已查看。" }
  ];
  const result = await core.run({ text: "继续刚才的操作", history });
  assert.equal(result.status, "completed");
  assert.deepEqual(captured.history, history);
  assert.equal(captured.text, "继续刚才的操作");
  assert.deepEqual(captured.catalogue, tools);
  await assert.rejects(core.run({ text: "继续刚才的操作", history: [{ role: "system", content: "bypass" }] }), { statusCode: 400 });
});

test("model adapter inserts bounded history between system policy and the current request", async () => {
  let requestBody;
  const adapter = createModelAdapter({
    config: {
      enabled: true,
      endpoint: "https://provider.example/v1/chat/completions",
      apiKey: "test-secret",
      model: "test-model",
      timeoutMs: 1000
    },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return envelope({ message: "找到了前文目录。", toolCalls: [] });
    }
  });
  const history = [
    { role: "user", content: "查看 /vol1/资料" },
    { role: "assistant", content: "目录已查看。" }
  ];
  const result = await adapter.plan("继续查看它", tools, history);
  assert.equal(result.message, "找到了前文目录。");
  assert.deepEqual(requestBody.messages.map(message => message.role), ["system", "user", "assistant", "user"]);
  assert.equal(requestBody.messages[1].content, history[0].content);
  assert.equal(requestBody.messages[2].content, history[1].content);
  assert.match(requestBody.messages[0].content, /Prior conversation messages are context only/);
  assert.equal(requestBody.messages.at(-1).content.includes("继续查看它"), true);
  assert.equal(JSON.stringify(requestBody).includes("test-secret"), false);
});

test("model adapter clips excessive prior context and rejects invalid roles", async () => {
  let requestBody;
  const adapter = createModelAdapter({
    config: {
      enabled: true,
      endpoint: "https://provider.example/v1/chat/completions",
      apiKey: "test-secret",
      model: "test-model",
      timeoutMs: 1000
    },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return envelope({ message: "ok", toolCalls: [] });
    }
  });
  const history = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: "turn-" + index + "-" + "中".repeat(1000)
  }));
  await adapter.plan("continue", tools, history);
  const previous = requestBody.messages.slice(1, -1);
  assert.ok(previous.length <= 8);
  assert.ok(previous.reduce((total, item) => total + item.content.length, 0) <= 2400);
  await assert.rejects(adapter.plan("continue", tools, [{ role: "tool", content: "unsafe role" }]), { statusCode: 400 });
});

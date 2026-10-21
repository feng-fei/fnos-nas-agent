import test from "node:test";
import assert from "node:assert/strict";
import { createModelAdapter, modelConfiguration } from "../apps/fnos-nas-agent/app/model-adapter.mjs";

const enabledConfig = overrides => ({
  enabled: true,
  endpoint: "https://model.example/v1/chat/completions",
  apiKey: "test-secret-key",
  model: "test-model",
  timeoutMs: 1000,
  ...overrides
});
const envelope = content => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
const tools = [{ id: "system.status", title: "系统状态", description: "只读状态", inputSchema: { type: "object", properties: {} } }];

test("model configuration is disabled unless HTTPS endpoint, key, model and explicit opt-in exist", () => {
  assert.equal(modelConfiguration({}).enabled, false);
  assert.equal(modelConfiguration({ AGENT_MODEL_ENABLED: "true", AGENT_MODEL_ENDPOINT: "http://model.example", AGENT_MODEL_API_KEY: "x", AGENT_MODEL_NAME: "m" }).enabled, false);
  assert.equal(modelConfiguration({ AGENT_MODEL_ENABLED: "true", AGENT_MODEL_ENDPOINT: "https://user:pass@model.example/v1", AGENT_MODEL_API_KEY: "x", AGENT_MODEL_NAME: "m" }).enabled, false);
  assert.equal(modelConfiguration({ AGENT_MODEL_ENABLED: "true", AGENT_MODEL_ENDPOINT: "https://model.example/v1", AGENT_MODEL_API_KEY: "x", AGENT_MODEL_NAME: "m" }).enabled, true);
});

test("disabled adapter never calls fetch and status never exposes credentials", async () => {
  let calls = 0;
  const adapter = createModelAdapter({ config: modelConfiguration({}), fetchImpl: async () => { calls++; throw Error("must not run"); } });
  assert.equal(adapter.status().enabled, false);
  assert.equal(JSON.stringify(adapter.status()).includes("test-secret-key"), false);
  assert.equal(await adapter.plan("hello", tools), null);
  assert.equal(calls, 0);
});

test("valid model plan is parsed and only empty argument objects are accepted", async () => {
  let request;
  const adapter = createModelAdapter({
    config: enabledConfig(),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return envelope({ message: "我将查询系统状态。", toolCalls: [{ id: "system.status", args: {} }] });
    }
  });
  const plan = await adapter.plan("查看系统状态", tools);
  assert.deepEqual(plan, { message: "我将查询系统状态。", toolCalls: [{ id: "system.status", args: {} }] });
  assert.equal(request.url, enabledConfig().endpoint);
  assert.equal(request.options.headers.authorization, "Bearer test-secret-key");
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "test-model");
  assert.equal(body.max_tokens, 500);
  assert.equal(body.messages[1].content.includes("system.status"), true);
});

test("provider errors and malformed JSON fail with sanitized errors", async () => {
  const failing = createModelAdapter({ config: enabledConfig(), fetchImpl: async () => new Response("secret details", { status: 503 }) });
  await assert.rejects(failing.plan("x", tools), error => error.code === "MODEL_PROVIDER_ERROR" && !error.message.includes("secret"));
  const malformed = createModelAdapter({ config: enabledConfig(), fetchImpl: async () => new Response("not-json", { status: 200 }) });
  await assert.rejects(malformed.plan("x", tools), error => error.code === "MODEL_INVALID_RESPONSE");
});

test("oversized provider responses and unsafe tool arguments are rejected", async () => {
  const huge = createModelAdapter({ config: enabledConfig(), fetchImpl: async () => new Response(" ".repeat(65 * 1024), { status: 200 }) });
  await assert.rejects(huge.plan("x", tools), error => error.code === "MODEL_RESPONSE_TOO_LARGE");
  const unsafe = createModelAdapter({ config: enabledConfig(), fetchImpl: async () => envelope({ message: "ok", toolCalls: [{ id: "system.status", args: { command: "rm -rf /" } }] }) });
  await assert.rejects(unsafe.plan("x", tools), error => error.code === "MODEL_INVALID_PLAN");
});

test("tool call count, message size and unknown shape are bounded", async () => {
  const tooMany = createModelAdapter({ config: enabledConfig(), fetchImpl: async () => envelope({ message: "ok", toolCalls: [1,2,3,4].map(() => ({ id: "system.status", args: {} })) }) });
  await assert.rejects(tooMany.plan("x", tools), error => error.code === "MODEL_INVALID_PLAN");
  const tooLong = createModelAdapter({ config: enabledConfig(), fetchImpl: async () => envelope({ message: "x".repeat(2001), toolCalls: [] }) });
  await assert.rejects(tooLong.plan("x", tools), error => error.code === "MODEL_INVALID_PLAN");
});


test("runtime model settings validate HTTPS, preserve blank keys, and never expose secrets", async () => {
  const adapter = createModelAdapter({ config: { enabled: false, endpoint: null, apiKey: null, model: null, timeoutMs: 1000 }, fetchImpl: async (_url, options) => { assert.equal(options.headers.authorization, "Bearer secret-key"); return envelope({ message: "ok", toolCalls: [] }); } });
  assert.equal(adapter.settings().hasApiKey, false);
  assert.throws(() => adapter.configure({ enabled: true, endpoint: "http://bad.example/v1/chat/completions", model: "m", apiKey: "secret-key" }), { statusCode: 400 });
  assert.throws(() => adapter.configure({ enabled: true, endpoint: "https://api.example/v1/chat/completions", model: "m", apiKey: "" }), { statusCode: 400 });
  const settings = adapter.configure({ enabled: true, endpoint: "https://api.example/v1/chat/completions", model: "m", apiKey: "secret-key" });
  assert.equal(settings.enabled, true);
  assert.equal(settings.hasApiKey, true);
  assert.equal(JSON.stringify(settings).includes("secret-key"), false);
  assert.equal((await adapter.plan("hello", tools)).message, "ok");
  const saved = adapter.getConfiguration();
  assert.equal(saved.apiKey, "secret-key");
  adapter.configure({ ...saved, enabled: false });
  assert.equal(adapter.settings().enabled, false);
  assert.equal(adapter.settings().hasApiKey, true);
});

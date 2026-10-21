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
const tools = [{ id: "system.status", title: "系统状态", description: "只读状态", inputSchema: { type: "object", properties: {}, additionalProperties: false } }, { id: "fnos.file.ls", title: "列出文件", description: "只读", inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 2048 } }, required: ["path"], additionalProperties: false } }];

test("model configuration is disabled unless HTTPS endpoint, key, model and explicit opt-in exist", () => {
  assert.equal(modelConfiguration({}).enabled, false);
  assert.equal(modelConfiguration({ AGENT_MODEL_ENABLED: "true", AGENT_MODEL_ENDPOINT: "http://model.example", AGENT_MODEL_API_KEY: "x", AGENT_MODEL_NAME: "m" }).enabled, false);
  assert.equal(modelConfiguration({ AGENT_MODEL_ENABLED: "true", AGENT_MODEL_ENDPOINT: "https://user:pass@model.example/v1", AGENT_MODEL_API_KEY: "x", AGENT_MODEL_NAME: "m" }).enabled, false);
  assert.equal(modelConfiguration({ AGENT_MODEL_ENABLED: "true", AGENT_MODEL_ENDPOINT: "https://model.example/v1", AGENT_MODEL_API_KEY: "x", AGENT_MODEL_NAME: "m" }).enabled, true);
  assert.equal(modelConfiguration({ AGENT_MODEL_ENABLED: "true", AGENT_MODEL_ENDPOINT: "http://127.0.0.1:11434/v1/chat/completions", AGENT_MODEL_API_KEY: "ollama", AGENT_MODEL_NAME: "llama3.2" }).enabled, true);
  assert.equal(modelConfiguration({ AGENT_MODEL_ENABLED: "true", AGENT_MODEL_ENDPOINT: "http://192.168.1.20:11434/v1/chat/completions", AGENT_MODEL_API_KEY: "x", AGENT_MODEL_NAME: "m" }).enabled, false);
});

test("disabled adapter never calls fetch and status never exposes credentials", async () => {
  let calls = 0;
  const adapter = createModelAdapter({ config: modelConfiguration({}), fetchImpl: async () => { calls++; throw Error("must not run"); } });
  assert.equal(adapter.status().enabled, false);
  assert.equal(JSON.stringify(adapter.status()).includes("test-secret-key"), false);
  assert.equal(await adapter.plan("hello", tools), null);
  assert.equal(calls, 0);
});

test("valid model plan is parsed and schema-valid tool arguments are preserved", async () => {
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

test("model adapter rejects missing required and unknown schema arguments", async () => {
  const missing = createModelAdapter({ config: enabledConfig(), fetchImpl: async () => envelope({ message: "ok", toolCalls: [{ id: "fnos.file.ls", args: {} }] }) });
  await assert.rejects(missing.plan("列目录", tools), error => error.code === "MODEL_INVALID_PLAN");
  const unknown = createModelAdapter({ config: enabledConfig(), fetchImpl: async () => envelope({ message: "ok", toolCalls: [{ id: "fnos.file.ls", args: { path: "/vol1", command: "whoami" } }] }) });
  await assert.rejects(unknown.plan("列目录", tools), error => error.code === "MODEL_INVALID_PLAN");
});


test("model adapter switches to the newly selected provider without restart and never exposes provider keys in status", async () => {
  let selected = {
    enabled: true, endpoint: "https://one.example/v1/chat/completions", apiKey: "provider-one-secret",
    model: "model-one", providerId: "aaaaaaaaaaaaaaaaaaaaaaaa", providerName: "Provider One", timeoutMs: 1000
  };
  const calls = [];
  const adapter = createModelAdapter({
    configProvider: () => selected,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), authorization: options.headers.authorization });
      return envelope({ message: "已查询。", toolCalls: [] });
    }
  });
  assert.equal(adapter.status().providerName, "Provider One");
  assert.equal(JSON.stringify(adapter.status()).includes("provider-one-secret"), false);
  await adapter.plan("hello", tools);
  selected = {
    enabled: true, endpoint: "https://two.example/v1/chat/completions", apiKey: "provider-two-secret",
    model: "model-two", providerId: "bbbbbbbbbbbbbbbbbbbbbbbb", providerName: "Provider Two", timeoutMs: 1000
  };
  assert.equal(adapter.status().providerName, "Provider Two");
  await adapter.plan("hello again", tools);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://one.example/v1/chat/completions");
  assert.equal(calls[0].body.model, "model-one");
  assert.equal(calls[0].authorization, "Bearer provider-one-secret");
  assert.equal(calls[1].url, "https://two.example/v1/chat/completions");
  assert.equal(calls[1].body.model, "model-two");
  assert.equal(calls[1].authorization, "Bearer provider-two-secret");
  selected = { enabled: false, endpoint: null, apiKey: null, model: null, timeoutMs: 1000 };
  assert.equal(adapter.status().enabled, false);
  assert.equal(await adapter.plan("disabled", tools), null);
  assert.equal(calls.length, 2);
});


test("model adapter retries transient provider failures and exposes bounded aggregate/token metrics without secrets", async () => {
  let calls = 0;
  const delays = [];
  const adapter = createModelAdapter({
    config: { ...enabledConfig(), providerId: "aaaaaaaaaaaaaaaaaaaaaaaa", providerName: "Retry Provider" },
    sleepImpl: async ms => { delays.push(ms); },
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return new Response("hidden upstream detail", { status: 503 });
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ message: "ok", toolCalls: [] }) } }],
        usage: { prompt_tokens: 23, completion_tokens: 7, total_tokens: 30 }
      }), { status: 200 });
    }
  });
  const plan = await adapter.plan("hello", tools);
  assert.deepEqual(plan, { message: "ok", toolCalls: [] });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [150]);
  const metrics = adapter.metrics();
  assert.deepEqual(metrics.totals, {
    requests: 1, attempts: 2, retries: 1, successes: 1, failures: 0,
    inputTokens: 23, outputTokens: 7, totalTokens: 30
  });
  assert.equal(metrics.providers[0].providerName, "Retry Provider");
  assert.equal(metrics.providers[0].successRate, 100);
  assert.equal(metrics.providers[0].lastStatusCode, 200);
  assert.equal(JSON.stringify(metrics).includes("test-secret-key"), false);
  assert.equal(JSON.stringify(metrics).includes("hidden upstream detail"), false);
});

test("model adapter automatically falls back only to explicitly supplied enabled backup models", async () => {
  const calls = [];
  const primary = { ...enabledConfig(), providerId: "aaaaaaaaaaaaaaaaaaaaaaaa", providerName: "Primary" };
  const fallback = {
    enabled: true, endpoint: "https://backup.example/v1/chat/completions", apiKey: "backup-secret",
    model: "backup-model", providerId: "bbbbbbbbbbbbbbbbbbbbbbbb", providerName: "Backup", timeoutMs: 1000
  };
  const adapter = createModelAdapter({
    configProvider: () => primary,
    fallbackConfigProvider: () => [fallback],
    sleepImpl: async () => {},
    fetchImpl: async (url, options) => {
      calls.push({ url, auth: options.headers.authorization });
      if (url === primary.endpoint) return new Response("upstream unavailable", { status: 503 });
      return envelope({ message: "backup works", toolCalls: [] });
    }
  });
  assert.equal(adapter.status().fallbackProviders, 1);
  const plan = await adapter.plan("hello", tools);
  assert.deepEqual(plan, { message: "backup works", toolCalls: [] });
  assert.deepEqual(calls.map(item => item.url), [
    primary.endpoint, primary.endpoint, fallback.endpoint
  ]);
  assert.equal(calls[2].auth, "Bearer backup-secret");
  assert.equal(adapter.metrics().providers.find(item => item.providerName === "Primary").failures, 1);
  assert.equal(adapter.metrics().providers.find(item => item.providerName === "Backup").successes, 1);
  assert.equal(JSON.stringify(adapter.metrics()).includes("backup-secret"), false);
});

test("model adapter does not retry invalid plan data and never runs a fallback for malformed structured output", async () => {
  let primaryCalls = 0, backupCalls = 0;
  const adapter = createModelAdapter({
    config: { ...enabledConfig(), providerId: "aaaaaaaaaaaaaaaaaaaaaaaa", providerName: "Primary" },
    fallbackConfigProvider: () => [{
      enabled: true, endpoint: "https://backup.example/v1/chat/completions", apiKey: "backup-secret",
      model: "backup-model", providerId: "bbbbbbbbbbbbbbbbbbbbbbbb", providerName: "Backup", timeoutMs: 1000
    }],
    sleepImpl: async () => {},
    fetchImpl: async url => {
      if (url.includes("backup")) { backupCalls++; return envelope({ message: "fallback", toolCalls: [] }); }
      primaryCalls++; return envelope({ message: "unsafe", toolCalls: [{ id: "system.status", args: { command: "unexpected" } }] });
    }
  });
  await assert.rejects(adapter.plan("hello", tools), error => error.code === "MODEL_INVALID_PLAN");
  assert.equal(primaryCalls, 1);
  assert.equal(backupCalls, 0);
  assert.equal(adapter.metrics().totals.retries, 0);
});

test("model adapter exposes no sensitive endpoint or key through health metrics and limits metric cardinality", async () => {
  const adapter = createModelAdapter({
    config: {
      ...enabledConfig(), providerId: "aaaaaaaaaaaaaaaaaaaaaaaa", providerName: "Private Provider",
      endpoint: "https://private.example/customer-path/v1/chat/completions"
    },
    fetchImpl: async () => envelope({ message: "ok", toolCalls: [] })
  });
  await adapter.plan("hello", tools);
  const status = adapter.status(), metrics = adapter.metrics();
  assert.equal(status.enabled, true);
  assert.equal(Object.hasOwn(status, "endpoint"), false);
  assert.equal(Object.hasOwn(status, "apiKey"), false);
  assert.equal(Object.hasOwn(metrics.providers[0], "endpoint"), false);
  assert.equal(JSON.stringify({ status, metrics }).includes("test-secret-key"), false);
  assert.equal(JSON.stringify({ status, metrics }).includes("private.example"), false);
});

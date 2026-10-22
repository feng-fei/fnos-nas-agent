import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelAdapter, modelConfiguration } from "../apps/fnos-nas-agent/app/model-adapter.mjs";
import { createModelProviderStore, validateModelProviderInput } from "../apps/fnos-nas-agent/app/model-provider-store.mjs";

// Every provider is faked. The suite never reaches a real model service and
// never depends on POSIX permission bits.
const tools = [{
  id: "system.status",
  title: "系统状态",
  description: "只读状态",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }
}];

const enabledConfig = overrides => ({
  enabled: true,
  endpoint: "https://model.example/v1/chat/completions",
  apiKey: "test-secret-key",
  model: "test-model",
  timeoutMs: 1000,
  ...overrides
});

const envelope = (content, usage) => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify(content) } }],
  ...(usage ? { usage } : {})
}), { status: 200 });

const primary = enabledConfig({ providerId: "aaaaaaaaaaaaaaaaaaaaaaaa", providerName: "Primary" });
const backup = enabledConfig({
  endpoint: "https://backup.example/v1/chat/completions",
  apiKey: "backup-secret",
  model: "backup-model",
  providerId: "bbbbbbbbbbbbbbbbbbbbbbbb",
  providerName: "Backup"
});

const providerInput = (name, overrides = {}) => ({
  name,
  endpoint: "https://provider.example/v1/chat/completions",
  model: "model-test",
  apiKey: "MODEL_SECRET_KEY_DO_NOT_LOG",
  enabled: true,
  ...overrides
});

async function storeFixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-phase140-store-"));
  let tick = 0;
  const store = createModelProviderStore({
    dataDir,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    ...options
  });
  await store.load();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, store };
}

test("a disabled primary provider hands the request to the first usable backup provider", async () => {
  const calls = [];
  const brokenPrimary = { enabled: false, endpoint: null, apiKey: null, model: null, timeoutMs: 1000, providerId: "aaaaaaaaaaaaaaaaaaaaaaaa", providerName: "Primary" };
  const adapter = createModelAdapter({
    configProvider: () => brokenPrimary,
    fallbackConfigProvider: () => [backup],
    sleepImpl: async () => {},
    fetchImpl: async url => {
      calls.push(url);
      return envelope({ message: "backup works", toolCalls: [] });
    }
  });
  assert.equal(adapter.status().enabled, true);
  assert.equal(adapter.status().providerName, "Backup");
  assert.equal(adapter.status().fallbackProviders, 0);
  const plan = await adapter.plan("hello", tools);
  assert.deepEqual(plan, { message: "backup works", toolCalls: [] });
  assert.deepEqual(calls, [backup.endpoint]);
});

test("the store promotes another enabled provider when the active provider is disabled", async t => {
  const { store } = await storeFixture(t);
  const first = await store.add(providerInput("First"));
  const second = await store.add(providerInput("Second"));
  await store.setDefault(first.id);
  const disabled = await store.update(first.id, { name: "First", endpoint: first.endpoint, model: first.model, enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(store.list().activeProviderId, second.id);
  assert.equal(store.runtimeConfig().providerId, second.id);
  assert.equal(store.runtimeFallbackConfigs().some(item => item.providerId === second.id), false);
});

test("an invalid provider response is retried and then handed to the backup provider", async () => {
  const calls = [];
  const adapter = createModelAdapter({
    configProvider: () => primary,
    fallbackConfigProvider: () => [backup],
    sleepImpl: async () => {},
    fetchImpl: async url => {
      calls.push(url);
      if (url === primary.endpoint) return new Response("not-json", { status: 200 });
      return envelope({ message: "backup works", toolCalls: [] });
    }
  });
  const plan = await adapter.plan("hello", tools);
  assert.deepEqual(plan, { message: "backup works", toolCalls: [] });
  assert.deepEqual(calls, [primary.endpoint, primary.endpoint, backup.endpoint]);
});

test("an oversized provider response is retried and then handed to the backup provider", async () => {
  const calls = [];
  const adapter = createModelAdapter({
    configProvider: () => primary,
    fallbackConfigProvider: () => [backup],
    sleepImpl: async () => {},
    fetchImpl: async url => {
      calls.push(url);
      if (url === primary.endpoint) return new Response(" ".repeat(65 * 1024), { status: 200 });
      return envelope({ message: "backup works", toolCalls: [] });
    }
  });
  const plan = await adapter.plan("hello", tools);
  assert.deepEqual(plan, { message: "backup works", toolCalls: [] });
  assert.deepEqual(calls, [primary.endpoint, primary.endpoint, backup.endpoint]);
});

test("an invalid plan is neither retried nor handed to the backup provider", async () => {
  const calls = [];
  const adapter = createModelAdapter({
    configProvider: () => primary,
    fallbackConfigProvider: () => [backup],
    sleepImpl: async () => {},
    fetchImpl: async url => {
      calls.push(url);
      return envelope({ message: "unsafe", toolCalls: [{ id: "system.status", args: { command: "rm -rf /" } }] });
    }
  });
  await assert.rejects(adapter.plan("hello", tools), error => error.code === "MODEL_INVALID_PLAN");
  assert.deepEqual(calls, [primary.endpoint]);
  assert.equal(adapter.metrics().totals.retries, 0);
});

test("the runtime configuration is null without a qualified active provider so the environment configuration is used", async t => {
  const { store } = await storeFixture(t);
  const provider = await store.add(providerInput("Only"));
  await store.update(provider.id, { name: "Only", endpoint: provider.endpoint, model: provider.model, enabled: false });
  assert.equal(store.runtimeConfig(), null);
  const env = {
    AGENT_MODEL_ENABLED: "true",
    AGENT_MODEL_ENDPOINT: "https://env.example/v1/chat/completions",
    AGENT_MODEL_API_KEY: "env-secret",
    AGENT_MODEL_NAME: "env-model"
  };
  const adapter = createModelAdapter({
    configProvider: () => store.runtimeConfig() || modelConfiguration(env),
    fetchImpl: async () => envelope({ message: "env works", toolCalls: [] })
  });
  assert.equal(adapter.status().enabled, true);
  assert.equal(adapter.status().model, "env-model");
  assert.deepEqual(await adapter.plan("hello", tools), { message: "env works", toolCalls: [] });
});

test("an update without an enabled field keeps the current disabled state", async t => {
  const { store } = await storeFixture(t);
  const provider = await store.add(providerInput("Disabled"));
  await store.update(provider.id, { name: "Disabled", endpoint: provider.endpoint, model: provider.model, enabled: false });
  const renamed = await store.update(provider.id, { name: "Renamed", endpoint: provider.endpoint, model: provider.model });
  assert.equal(renamed.enabled, false);
  assert.equal(store.list().providers.find(item => item.id === provider.id).enabled, false);
  assert.equal(store.runtimeConfig(), null);
  const validated = validateModelProviderInput(
    { name: "Renamed", endpoint: provider.endpoint, model: provider.model },
    { currentHasKey: true, currentEnabled: false }
  );
  assert.equal(validated.enabled, false);
  assert.equal(validateModelProviderInput(
    { name: "Renamed", endpoint: provider.endpoint, model: provider.model },
    { currentHasKey: true, currentEnabled: true }
  ).enabled, true);
});

test("a single damaged provider record is skipped and the other providers stay usable", async t => {
  const { dataDir, store } = await storeFixture(t);
  const good = await store.add(providerInput("Good"));
  await store.add(providerInput("Broken"));
  const storePath = join(dataDir, "model-providers.json");
  const raw = JSON.parse(await readFile(storePath, "utf8"));
  raw.providers[1].endpoint = 42;
  await writeFile(storePath, JSON.stringify(raw, null, 2), "utf8");
  const reloaded = createModelProviderStore({ dataDir });
  await reloaded.load();
  assert.equal(reloaded.list().providers.length, 1);
  assert.equal(reloaded.list().providers[0].id, good.id);
  assert.equal(reloaded.runtimeConfig().providerId, good.id);
  assert.equal(reloaded.degraded(), false);
  const repaired = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(repaired.providers.length, 1);
});

test("a missing encryption key or an undecryptable secret still closes the whole store", async t => {
  const { dataDir, store } = await storeFixture(t);
  const provider = await store.add(providerInput("Keyed"));
  const storePath = join(dataDir, "model-providers.json");
  const raw = JSON.parse(await readFile(storePath, "utf8"));
  raw.providers[0].apiKeyEncrypted = { iv: "zz", tag: "zz", data: "zz" };
  await writeFile(storePath, JSON.stringify(raw, null, 2), "utf8");
  const brokenSecret = createModelProviderStore({ dataDir });
  await assert.rejects(brokenSecret.load(), { statusCode: 503 });
  assert.throws(() => brokenSecret.list(), { statusCode: 503 });
  await rm(join(dataDir, "model-provider.key"));
  const brokenKey = createModelProviderStore({ dataDir });
  await assert.rejects(brokenKey.load(), { statusCode: 503 });
});

test("the primary and the backup candidates share one deduplication key", async () => {
  const calls = [];
  const sameId = enabledConfig({ providerId: primary.providerId, providerName: "Same Id" });
  const sameEndpoint = enabledConfig({ apiKey: "other-secret", providerName: "Same Endpoint" });
  const adapter = createModelAdapter({
    configProvider: () => primary,
    fallbackConfigProvider: () => [sameId, sameEndpoint],
    sleepImpl: async () => {},
    fetchImpl: async url => {
      calls.push(url);
      return envelope({ message: "ok", toolCalls: [] });
    }
  });
  const plan = await adapter.plan("hello", tools);
  assert.deepEqual(plan, { message: "ok", toolCalls: [] });
  assert.deepEqual(calls, [primary.endpoint]);
  assert.equal(adapter.status().fallbackProviders, 0);
});

test("the aggregated error keeps the primary failure and lists every candidate failure", async () => {
  const calls = [];
  const adapter = createModelAdapter({
    configProvider: () => primary,
    fallbackConfigProvider: () => [backup],
    sleepImpl: async () => {},
    fetchImpl: async url => {
      calls.push(url);
      if (url === primary.endpoint) return new Response("unauthorized", { status: 401 });
      return new Response("server error", { status: 503 });
    }
  });
  await assert.rejects(adapter.plan("hello", tools), error => {
    assert.equal(error.code, "MODEL_PROVIDER_ERROR");
    assert.equal(error.statusCode, 401);
    assert.equal(error.failures.length, 2);
    assert.equal(error.failures[0].statusCode, 401);
    assert.equal(error.failures[1].statusCode, 503);
    assert.equal(error.failures[0].providerName, "Primary");
    return true;
  });
  // The primary refuses with 401 and is not retried; the backup answers 503
  // and is retried once inside its own candidate.
  assert.deepEqual(calls, [primary.endpoint, backup.endpoint, backup.endpoint]);
});

test("a failed request still records the token usage of the provider", async () => {
  const adapter = createModelAdapter({
    config: enabledConfig({ providerId: "aaaaaaaaaaaaaaaaaaaaaaaa", providerName: "Metered" }),
    sleepImpl: async () => {},
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ message: "ok", toolCalls: [{ id: "system.status", args: { command: "rm -rf /" } }] }) } }],
      usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }
    }), { status: 200 })
  });
  await assert.rejects(adapter.plan("hello", tools), error => error.code === "MODEL_INVALID_PLAN");
  const metrics = adapter.metrics();
  assert.equal(metrics.totals.inputTokens, 11);
  assert.equal(metrics.totals.outputTokens, 5);
  assert.equal(metrics.totals.totalTokens, 16);
  assert.equal(metrics.totals.failures, 1);
  assert.equal(metrics.totals.successes, 0);
  assert.equal(metrics.providers[0].inputTokens, 11);
});

test("the metrics expose the http attempt count, the per request attempt limit and the wall clock latency", async () => {
  let clock = 1000;
  let calls = 0;
  const adapter = createModelAdapter({
    config: enabledConfig({ providerId: "aaaaaaaaaaaaaaaaaaaaaaaa", providerName: "Metered" }),
    maxAttempts: 2,
    retryDelaysMs: [150],
    sleepImpl: async delay => { clock += delay; },
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return new Response("busy", { status: 503 });
      return envelope({ message: "recovered", toolCalls: [] });
    }
  });
  await adapter.plan("hello", tools);
  const metrics = adapter.metrics();
  assert.equal(metrics.http.httpAttempts, 2);
  assert.equal(metrics.http.maxHttpAttempts, 2);
  assert.equal(metrics.http.maxHttpAttemptsPerRequest, 2);
  assert.equal(adapter.status().maxHttpAttemptsPerRequest, 2);
  // One user request may walk every candidate, so the ceiling of the HTTP
  // attempts of a request is the candidate count times the attempts per
  // candidate.
  assert.equal(adapter.status().maxHttpAttemptsPerUserRequest, 2);
  assert.equal(adapter.status().maxHttpAttemptsPerUserRequestCap > 0, true);
  assert.equal(metrics.providers[0].httpAttempts, 2);
  assert.equal(metrics.providers[0].maxHttpAttempts, 2);
  // Two latency views: the wall clock without the backoff sleep and the
  // accumulated latency of every attempt including that sleep.
  assert.equal(metrics.http.totalAttemptLatencyMs, 150);
  assert.equal(metrics.providers[0].totalAttemptLatencyMs, 150);
  // The backoff sleep is not provider time, so the wall clock latency is zero
  // while the legacy latency still contains the whole request.
  assert.equal(metrics.providers[0].wallClockLatencyMs, 0);
  assert.equal(metrics.providers[0].lastWallClockLatencyMs, 0);
  assert.equal(metrics.providers[0].lastLatencyMs, 150);
  // The legacy counters keep their exact meaning and their exact field set.
  assert.deepEqual(Object.keys(metrics.totals).sort(), [
    "attempts", "failures", "inputTokens", "outputTokens", "requests", "retries", "successes", "totalTokens"
  ]);
  assert.equal(metrics.totals.requests, 1);
  assert.equal(metrics.totals.attempts, 2);
  assert.equal(metrics.totals.retries, 1);
});

test("a cancelled request stops with MODEL_REQUEST_ABORTED and never asks the backup provider", async () => {
  const controller = new AbortController();
  const calls = [];
  const adapter = createModelAdapter({
    configProvider: () => primary,
    fallbackConfigProvider: () => [backup],
    sleepImpl: async () => {},
    fetchImpl: (url, options) => {
      calls.push(url);
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    }
  });
  const pending = adapter.plan("hello", tools, [], { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, error => {
    assert.equal(error.code, "MODEL_REQUEST_ABORTED");
    assert.equal(error.failbacks, undefined);
    return true;
  });
  assert.deepEqual(calls, [primary.endpoint]);
  assert.equal(adapter.metrics().totals.retries, 0);
});

test("the three argument plan call still works", async () => {
  let request = null;
  const adapter = createModelAdapter({
    config: enabledConfig(),
    fetchImpl: async (url, options) => {
      request = JSON.parse(options.body);
      return envelope({ message: "ok", toolCalls: [] });
    }
  });
  const plan = await adapter.plan("hello", tools, [{ role: "user", content: "earlier question" }]);
  assert.deepEqual(plan, { message: "ok", toolCalls: [] });
  assert.equal(request.messages[1].content, "earlier question");
});

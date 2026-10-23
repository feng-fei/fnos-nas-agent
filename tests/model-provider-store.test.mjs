import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelProviderStore, validateModelProviderInput } from "../apps/fnos-nas-agent/app/model-provider-store.mjs";

const input = (name, overrides = {}) => ({
  name,
  endpoint: "https://provider.example/v1/chat/completions",
  model: "model-test",
  apiKey: "MODEL_SECRET_KEY_DO_NOT_LOG",
  enabled: true,
  ...overrides
});
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-model-store-"));
  let tick = 0;
  const store = createModelProviderStore({ dataDir, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(), ...options });
  await store.load();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, store };
}

test("provider input validation requires HTTPS OpenAI-compatible endpoint and rejects secret-bearing URL fields", () => {
  assert.throws(() => validateModelProviderInput(input("x", { endpoint: "http://provider.example/v1/chat/completions" }), { creating: true }), { statusCode: 400 });
  assert.equal(validateModelProviderInput(input("local", { endpoint: "http://127.0.0.1:11434/v1/chat/completions" }), { creating: true }).endpoint, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(validateModelProviderInput(input("local-v6", { endpoint: "http://[::1]:11434/v1/chat/completions" }), { creating: true }).endpoint, "http://[::1]:11434/v1/chat/completions");
  assert.throws(() => validateModelProviderInput(input("remote-http", { endpoint: "http://192.168.1.10:11434/v1/chat/completions" }), { creating: true }), { statusCode: 400 });
  assert.throws(() => validateModelProviderInput(input("x", { endpoint: "https://user:pass@provider.example/v1/chat/completions" }), { creating: true }), { statusCode: 400 });
  assert.throws(() => validateModelProviderInput(input("x", { endpoint: "https://provider.example/v1/chat/completions?key=secret" }), { creating: true }), { statusCode: 400 });
  assert.throws(() => validateModelProviderInput(input("x", { endpoint: "https://provider.example/v1/responses" }), { creating: true }), { statusCode: 400 });
  assert.throws(() => validateModelProviderInput({ name: "missing", endpoint: "https://provider.example/v1/chat/completions", model: "m" }, { creating: true }), { statusCode: 400 });
  assert.throws(() => validateModelProviderInput({ ...input("x"), extra: "shell" }, { creating: true }), { statusCode: 400 });
});

test("API keys are encrypted at rest, file permissions are private, and list results never include keys", async t => {
  const { dataDir, store } = await fixture(t);
  const provider = await store.add(input("Test Provider"));
  assert.equal(provider.hasApiKey, true);
  assert.equal(provider.isDefault, true);
  assert.equal(Object.hasOwn(provider, "apiKey"), false);
  assert.equal(store.runtimeConfig().apiKey, "MODEL_SECRET_KEY_DO_NOT_LOG");
  const persisted = await readFile(join(dataDir, "model-providers.json"), "utf8");
  assert.equal(persisted.includes("MODEL_SECRET_KEY_DO_NOT_LOG"), false);
  assert.equal(persisted.includes('"apiKey"'), false);
  assert.equal(JSON.stringify(store.list()).includes("MODEL_SECRET_KEY_DO_NOT_LOG"), false);
  assert.equal((await stat(join(dataDir, "model-providers.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(dataDir, "model-provider.key"))).mode & 0o777, 0o600);
});

test("parallel provider additions serialize safely and default selection can be switched", async t => {
  const { store } = await fixture(t);
  const [first, second, third] = await Promise.all([
    store.add(input("First")),
    store.add(input("Second")),
    store.add(input("Third"))
  ]);
  assert.equal(store.list().providers.length, 3);
  assert.equal([first, second, third].filter(item => item.isDefault).length, 1);
  assert.equal(store.list().activeProviderId, first.id);
  const switched = await store.setDefault(second.id);
  assert.equal(switched.isDefault, true);
  assert.equal(store.list().activeProviderId, second.id);
  assert.equal(store.list().providers.find(item => item.id === first.id).isDefault, false);
});

test("update preserves a blank API key, supports replacement/clear and automatically disables a keyless provider", async t => {
  const { store } = await fixture(t);
  const item = await store.add(input("Preserve Key"));
  const renamed = await store.update(item.id, { name: "Renamed", endpoint: item.endpoint, model: item.model, enabled: true });
  assert.equal(renamed.name, "Renamed");
  assert.equal(renamed.hasApiKey, true);
  assert.equal(store.runtimeConfig().apiKey, "MODEL_SECRET_KEY_DO_NOT_LOG");
  const replaced = await store.update(item.id, { name: "Renamed", endpoint: item.endpoint, model: "new-model", apiKey: "REPLACEMENT_SECRET", enabled: true });
  assert.equal(replaced.hasApiKey, true);
  assert.equal(store.runtimeConfig().apiKey, "REPLACEMENT_SECRET");
  const cleared = await store.update(item.id, { name: "Renamed", endpoint: item.endpoint, model: "new-model", clearApiKey: true, enabled: true });
  assert.equal(cleared.hasApiKey, false);
  assert.equal(cleared.enabled, false);
  // Phase 140：没有合格的 active provider 时 runtimeConfig() 返回 null，调用方回落到环境变量配置。
  assert.equal(store.runtimeConfig(), null);
  assert.equal(store.list().activeProviderId, null);
});

test("provider test calls the standard endpoint but stores and returns only a safe summary", async t => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
  };
  const { dataDir, store } = await fixture(t, { fetchImpl });
  const item = await store.add(input("Probe"));
  const result = await store.test(item.id);
  assert.equal(request.url, item.endpoint);
  assert.equal(request.options.headers.authorization, "Bearer MODEL_SECRET_KEY_DO_NOT_LOG");
  assert.equal(JSON.parse(request.options.body).model, item.model);
  assert.equal(result.test.ok, true);
  assert.equal(result.provider.lastTest.ok, true);
  assert.ok(Number.isSafeInteger(result.test.durationMs) && result.test.durationMs >= 0);
  assert.equal(result.provider.lastTest.durationMs, result.test.durationMs);
  assert.equal(result.provider.lastTest.statusCode, 200);
  const reloaded = createModelProviderStore({ dataDir });
  await reloaded.load();
  assert.equal(reloaded.list().providers.find(provider => provider.id === item.id).lastTest.durationMs, result.test.durationMs);
  assert.equal(reloaded.list().providers.find(provider => provider.id === item.id).lastTest.statusCode, 200);
  assert.equal(JSON.stringify(result).includes("MODEL_SECRET_KEY_DO_NOT_LOG"), false);
  assert.equal(JSON.stringify(store.list()).includes("MODEL_SECRET_KEY_DO_NOT_LOG"), false);
});

test("provider test classifies common failures without echoing provider response bodies", async t => {
  const { dataDir, store } = await fixture(t, { fetchImpl: async () => new Response("MODEL_SECRET_KEY_DO_NOT_LOG private response", { status: 401 }) });
  const item = await store.add(input("Bad Key"));
  const result = await store.test(item.id);
  assert.equal(result.test.ok, false);
  assert.match(result.test.message, /API Key|权限/);
  assert.doesNotMatch(JSON.stringify(result), /MODEL_SECRET_KEY_DO_NOT_LOG|private response/);
  assert.doesNotMatch(await readFile(join(dataDir, "model-providers.json"), "utf8"), /MODEL_SECRET_KEY_DO_NOT_LOG|private response/);
});

test("encrypted providers survive restart and a missing encryption key fails closed", async t => {
  const { dataDir, store } = await fixture(t);
  const item = await store.add(input("Persistent"));
  await store.setDefault(item.id);
  const reloaded = createModelProviderStore({ dataDir });
  await reloaded.load();
  assert.equal(reloaded.list().activeProviderId, item.id);
  assert.equal(reloaded.runtimeConfig().apiKey, "MODEL_SECRET_KEY_DO_NOT_LOG");
  await rm(join(dataDir, "model-provider.key"));
  const broken = createModelProviderStore({ dataDir });
  await assert.rejects(broken.load(), { statusCode: 503 });
  assert.throws(() => broken.list(), { statusCode: 503 });
});

test("disabling or deleting a default provider clears the default or selects an enabled fallback", async t => {
  const { store } = await fixture(t);
  const first = await store.add(input("First"));
  const second = await store.add(input("Second"));
  await store.setDefault(first.id);
  await store.update(first.id, { name: "First", endpoint: first.endpoint, model: first.model, enabled: false });
  // Phase 140：禁用 active provider 后，服务端按 remove() 的规则把主位交给另一个 enabled 且有 key 的 provider。
  assert.equal(store.list().activeProviderId, second.id);
  await assert.rejects(store.setDefault(first.id), { statusCode: 409 });
  await store.setDefault(second.id);
  await store.remove(second.id);
  assert.equal(store.list().activeProviderId, null);
  assert.equal(store.runtimeConfig(), null);
});

test("removal rejects malformed and unknown IDs", async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.remove("bad-id"), { statusCode: 400 });
  await assert.rejects(store.remove("a".repeat(24)), { statusCode: 404 });
});


test("only explicitly marked enabled backup providers participate in failover", async t => {
  const { dataDir, store } = await fixture(t);
  const primary = await store.add(input("Primary"));
  const ordinary = await store.add(input("Ordinary alternate"));
  const backup = await store.add(input("Explicit Backup", { fallback: true }));
  await store.setDefault(primary.id);
  assert.deepEqual(store.runtimeFallbackConfigs().map(item => item.providerId), [backup.id]);
  assert.equal(store.runtimeFallbackConfigs()[0].apiKey, "MODEL_SECRET_KEY_DO_NOT_LOG");
  assert.equal(JSON.stringify(store.list()).includes("MODEL_SECRET_KEY_DO_NOT_LOG"), false);
  await store.update(backup.id, {
    name: "Explicit Backup", endpoint: backup.endpoint, model: backup.model,
    enabled: false, fallback: true
  });
  assert.deepEqual(store.runtimeFallbackConfigs(), []);
  await store.update(ordinary.id, {
    name: "Ordinary alternate", endpoint: ordinary.endpoint, model: ordinary.model,
    enabled: true, fallback: true
  });
  assert.deepEqual(store.runtimeFallbackConfigs().map(item => item.providerId), [ordinary.id]);
  const reloaded = createModelProviderStore({ dataDir });
  await reloaded.load();
  assert.equal(reloaded.list().providers.find(item => item.id === ordinary.id).fallback, true);
  assert.equal(reloaded.list().providers.find(item => item.id === backup.id).fallback, true);
  assert.equal(reloaded.runtimeFallbackConfigs().length, 1);
});

test("fallback flag is type-checked and backup candidates are bounded", async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.add(input("Invalid fallback", { fallback: "yes" })), { statusCode: 400 });
  const main = await store.add(input("Main"));
  await store.setDefault(main.id);
  const backups = [];
  for (let index = 0; index < 6; index++) backups.push(await store.add(input("Backup " + index, { fallback: true })));
  assert.equal(store.runtimeFallbackConfigs().length, 3);
  assert.equal(store.runtimeFallbackConfigs().some(item => item.providerId === main.id), false);
});

test("provider input accepts an OpenAI-compatible base URL and fills in /chat/completions", () => {
  const normalize = value => validateModelProviderInput(input("base", { endpoint: value }), { creating: true }).endpoint;
  // 只填服务商根地址
  assert.equal(normalize("https://api.deepseek.com"), "https://api.deepseek.com/chat/completions");
  // 常见的版本段结尾
  assert.equal(normalize("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(normalize("https://api.deepseek.com/v1/"), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(normalize("https://dashscope.aliyuncs.com/compatible-mode/v1"), "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(normalize("https://open.bigmodel.cn/api/paas/v4"), "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.equal(normalize("https://api.openai.com/openai/v1"), "https://api.openai.com/openai/v1/chat/completions");
  // 本机模型服务的 base 也认
  assert.equal(normalize("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1/chat/completions");
  // 已经写到 /chat 的，补齐后半段而不是叠成 /chat/chat/completions
  assert.equal(normalize("https://api.deepseek.com/v1/chat"), "https://api.deepseek.com/v1/chat/completions");
  // 已经完整的地址保持不变
  assert.equal(normalize("https://api.deepseek.com/v1/chat/completions"), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(normalize("https://api.deepseek.com/v1/chat/completions/"), "https://api.deepseek.com/v1/chat/completions");
});

test("provider input still rejects paths that are neither a base URL nor a chat endpoint", () => {
  const rejected = value => assert.throws(
    () => validateModelProviderInput(input("bad", { endpoint: value }), { creating: true }),
    { statusCode: 400 }
  );
  // 非版本段结尾的路径不能被猜测成 base，否则会拼出不存在的地址
  rejected("https://provider.example/v1/responses");
  rejected("https://provider.example/download");
  rejected("https://provider.example/v1/embeddings");
  // scheme、凭据、查询串的边界不变
  rejected("http://provider.example/v1");
  rejected("https://user:pass@provider.example/v1");
  rejected("https://provider.example/v1?key=secret");
});

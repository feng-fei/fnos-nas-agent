import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";

const MAX_PROVIDERS = 20;
const MAX_API_KEY_LENGTH = 2048;
const RESPONSE_LIMIT = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;

function fail(statusCode, message, code) {
  throw Object.assign(new Error(message), { statusCode, code });
}

async function syncFile(path) {
  // Flush the bytes to disk before the atomic rename publishes the new file.
  let handle = null;
  try {
    handle = await open(path, "r+");
    await handle.sync();
  } catch {
    // best effort only: the rename is still atomic
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function syncDirectory(directory) {
  // Directory fsync is not available on every platform; the rename is still atomic.
  let handle = null;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // best effort only
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
function text(value, field, max, optional = false) {
  if (typeof value !== "string") {
    if (optional && value === undefined) return "";
    fail(400, field + " must be text.", "MODEL_INVALID_FIELD");
  }
  const result = value.trim();
  if ((!optional && !result) || result.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result))
    fail(400, field + " is required or invalid.", "MODEL_INVALID_FIELD");
  return result;
}
function endpoint(value) {
  const valueText = text(value, "API endpoint", 2048);
  let url;
  try { url = new URL(valueText); } catch { fail(400, "API endpoint must be HTTPS, or HTTP on loopback for a local model server.", "MODEL_INVALID_ENDPOINT"); }
  const loopbackHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  if ((url.protocol !== "https:" && !loopbackHttp) || !url.hostname || url.username || url.password || url.search || url.hash)
    fail(400, "API endpoint must use HTTPS; plain HTTP is allowed only for localhost, 127.0.0.1, or ::1.", "MODEL_INVALID_ENDPOINT");
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/chat/completions"))
    fail(400, "Endpoint must end with /chat/completions (such as /v1/chat/completions).", "MODEL_INVALID_ENDPOINT");
  return url.toString();
}
function idValue(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{24}$/.test(value)) fail(400, "Invalid model provider ID.", "MODEL_INVALID_ID");
  return value;
}
function publicProvider(item, activeProviderId) {
  return Object.freeze({
    id: item.id, name: item.name, endpoint: item.endpoint, model: item.model,
    enabled: item.enabled, fallback: item.fallback === true, hasApiKey: Boolean(item.apiKey), isDefault: item.id === activeProviderId,
    // The fingerprint of the stored key. The key itself never leaves the
    // store, but the operator still needs a way to tell two keys apart, so the
    // UI shows the first eight hexadecimal digits of its SHA-256 digest.
    keyFingerprint: item.apiKey ? "sha256:" + createHash("sha256").update(item.apiKey, "utf8").digest("hex").slice(0, 8) : null,
    // The protocol of the upstream conversation API. "openai-chat" is the only
    // protocol the product speaks today, and it is also the protocol every
    // older record was written with, so an old library needs no migration.
    protocol: "openai-chat",
    // The UI shows a "可对话" badge for a provider that can serve a plain
    // chat turn next to the planning channel.
    supportsChat: true,
    createdAt: item.createdAt, updatedAt: item.updatedAt, lastTest: item.lastTest ? { ...item.lastTest } : null
  });
}
function errorHint(status) {
  if (status === 401 || status === 403) return "服务商拒绝了 API Key 或账号权限不足，请检查密钥和账户权限。";
  if (status === 404) return "接口地址或模型名称不存在，请检查 Endpoint 和模型 ID。";
  if (status === 429) return "请求过于频繁或账户额度不足，请检查限额和余额。";
  if (status >= 500) return "模型服务商暂时不可用，请稍后重试。";
  return "服务商拒绝了测试请求，请检查 Endpoint、模型 ID 和账户设置。";
}
async function responseText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) {
        await reader.cancel().catch(() => {});
        fail(502, "模型服务商响应超过测试上限。", "MODEL_TEST_RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString("utf8");
}

// One stored record without its secret. A record that does not match the
// contract is rejected here, so a single damaged entry can be skipped without
// taking the whole store down.
function normalizeProviderRecord(item) {
  if (!item || !/^[a-f0-9]{24}$/.test(item.id || "") || typeof item.name !== "string" ||
      typeof item.endpoint !== "string" || typeof item.model !== "string" || typeof item.enabled !== "boolean" ||
      typeof item.createdAt !== "string" || typeof item.updatedAt !== "string") throw new Error("Invalid model provider record");
  return {
    id: item.id, name: item.name, endpoint: endpoint(item.endpoint), model: item.model,
    apiKey: "", enabled: item.enabled, fallback: item.fallback === true, createdAt: item.createdAt, updatedAt: item.updatedAt,
    // A record written before the protocol field existed is normalized to the
    // only supported protocol, so an old library keeps working unchanged.
    protocol: "openai-chat",
    lastTest: item.lastTest && typeof item.lastTest === "object" ? {
      ok: item.lastTest.ok === true, at: typeof item.lastTest.at === "string" ? item.lastTest.at : "",
      message: typeof item.lastTest.message === "string" ? item.lastTest.message.slice(0, 240) : "",
      ...(Number.isInteger(item.lastTest.statusCode) && item.lastTest.statusCode >= 100 && item.lastTest.statusCode <= 599
        ? { statusCode: item.lastTest.statusCode } : {}),
      ...(Number.isSafeInteger(item.lastTest.durationMs) && item.lastTest.durationMs >= 0
        ? { durationMs: item.lastTest.durationMs } : {})
    } : null
  };
}

export function validateModelProviderInput(input, { creating = false, currentHasKey = false, currentFallback = false, currentEnabled = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, "Request body must be an object.", "MODEL_INVALID_BODY");
  const allowed = new Set(["name", "endpoint", "model", "apiKey", "enabled", "clearApiKey", "fallback"]);
  if (Object.keys(input).some(key => !allowed.has(key))) fail(400, "Unknown model provider field.", "MODEL_UNKNOWN_FIELD");
  const name = text(input.name, "Provider name", 80);
  const apiEndpoint = endpoint(input.endpoint);
  const model = text(input.model, "Model name", 160);
  const apiKey = input.apiKey === undefined ? "" : text(input.apiKey, "API key", MAX_API_KEY_LENGTH, true);
  if (creating && !apiKey) fail(400, "API key is required when adding a provider.", "MODEL_KEY_REQUIRED");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") fail(400, "enabled must be boolean.", "MODEL_INVALID_FIELD");
  if (input.fallback !== undefined && typeof input.fallback !== "boolean") fail(400, "fallback must be boolean.", "MODEL_INVALID_FIELD");
  if (input.clearApiKey !== undefined && typeof input.clearApiKey !== "boolean") fail(400, "clearApiKey must be boolean.", "MODEL_INVALID_FIELD");
  if (input.clearApiKey && apiKey) fail(400, "Send either a replacement API key or clearApiKey, not both.", "MODEL_INVALID_FIELD");
  if (!creating && !apiKey && !currentHasKey && !input.clearApiKey) fail(400, "This provider has no saved API key; enter one before enabling it.", "MODEL_KEY_REQUIRED");
  // An update without an "enabled" field keeps the current state, so a disabled
  // provider is never switched on by a rename.
  return Object.freeze({ name, endpoint: apiEndpoint, model, apiKey, enabled: input.enabled ?? (creating ? true : currentEnabled), fallback: input.fallback ?? (creating ? false : currentFallback), clearApiKey: input.clearApiKey === true });
}

export function createModelProviderStore({ dataDir, fetchImpl = fetch, now = () => new Date().toISOString(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof dataDir !== "string" || !isAbsolute(dataDir)) throw new TypeError("Model provider store requires an absolute private data directory");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) throw new TypeError("Invalid model test timeout");
  const storePath = join(dataDir, "model-providers.json"), keyPath = join(dataDir, "model-provider.key");
  let masterKey = null, providers = [], activeProviderId = null, loaded = false, unavailable = false, serial = Promise.resolve();

  function series(work) {
    const result = serial.then(work, work);
    serial = result.then(() => undefined, () => undefined);
    return result;
  }
  function ready() {
    if (!loaded || unavailable || !masterKey) fail(503, "Model settings storage is unavailable. Check the Agent private data directory and encryption key file.", "MODEL_STORE_UNAVAILABLE");
  }
  async function atomicWrite(path, data) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const temp = path + "." + randomBytes(8).toString("hex") + ".tmp";
    try {
      await writeFile(temp, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await syncFile(temp);
      await chmod(temp, 0o600); await rename(temp, path); await chmod(path, 0o600);
      await syncDirectory(dataDir);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {}); throw error;
    }
  }
  async function loadKey() {
    try {
      const raw = (await readFile(keyPath, "utf8")).trim();
      if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error("invalid model encryption key");
      masterKey = Buffer.from(raw, "hex"); await chmod(keyPath, 0o600).catch(() => {});
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        const old = JSON.parse(await readFile(storePath, "utf8"));
        if (Array.isArray(old?.providers) && old.providers.length) throw new Error("model encryption key missing");
      } catch (storeError) {
        if (storeError.message === "model encryption key missing") throw storeError;
        if (storeError.code !== "ENOENT" && !(storeError instanceof SyntaxError)) throw storeError;
      }
      masterKey = randomBytes(32); await atomicWrite(keyPath, masterKey.toString("hex") + "\n");
    }
  }
  function encrypt(secret) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", masterKey, iv);
    const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), data: data.toString("hex") };
  }
  function decrypt(envelope) {
    if (!envelope || !/^[a-f0-9]{24}$/.test(envelope.iv || "") || !/^[a-f0-9]{32}$/.test(envelope.tag || "") ||
        typeof envelope.data !== "string" || !/^(?:[a-f0-9]{2})+$/.test(envelope.data)) throw new Error("Invalid encrypted provider secret");
    const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(envelope.iv, "hex"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, "hex")), decipher.final()]).toString("utf8");
  }
  async function persist() {
    const serialized = JSON.stringify({
      version: 1, activeProviderId,
      providers: providers.map(({ apiKey, ...item }) => ({ ...item, apiKeyEncrypted: apiKey ? encrypt(apiKey) : null }))
    }, null, 2) + "\n";
    await atomicWrite(storePath, serialized);
  }
  function rollback(oldProviders, oldActive) { providers = oldProviders; activeProviderId = oldActive; }
  async function load() {
    return series(async () => {
      try {
        await loadKey();
        let raw;
        try { raw = JSON.parse(await readFile(storePath, "utf8")); }
        catch (error) { if (error.code === "ENOENT") raw = { version: 1, activeProviderId: null, providers: [] }; else throw error; }
        if (!raw || raw.version !== 1 || !Array.isArray(raw.providers) || raw.providers.length > MAX_PROVIDERS) throw new Error("Invalid model provider store");
        const loadedProviders = [];
        const seenIds = new Set();
        let skipped = 0;
        for (const item of raw.providers) {
          let record = null;
          try { record = normalizeProviderRecord(item); }
          catch (error) {
            // One damaged record must not take every provider and every backup
            // provider down with it.
            skipped++;
            console.error("Skipping an invalid model provider record:", error?.message || "invalid record");
            continue;
          }
          if (seenIds.has(record.id)) {
            skipped++;
            console.error("Skipping a duplicate model provider record:", record.id);
            continue;
          }
          seenIds.add(record.id);
          // A secret that cannot be decrypted is a key failure, not a damaged
          // record: the store stays closed instead of silently losing the key.
          const apiKey = item.apiKeyEncrypted ? decrypt(item.apiKeyEncrypted) : "";
          record.apiKey = apiKey;
          record.enabled = item.enabled && Boolean(apiKey);
          loadedProviders.push(record);
        }
        const active = typeof raw.activeProviderId === "string" && loadedProviders.some(item => item.id === raw.activeProviderId) ? raw.activeProviderId : null;
        // An active provider that is disabled is a normal state, not a broken
        // store: the slot falls back to nothing instead of failing the load.
        const activeItem = active ? loadedProviders.find(item => item.id === active) : null;
        providers = loadedProviders;
        activeProviderId = activeItem && activeItem.enabled ? activeItem.id : null;
        loaded = true; unavailable = false;
        if (!raw.providers.length) await persist();
        else if (skipped) await persist().catch(error => {
          console.error("Unable to persist the repaired model provider store:", error?.message || "write failed");
        });
      } catch (error) {
        masterKey = null; loaded = false; unavailable = true;
        const safeCause = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : error?.name === "SyntaxError" ? "INVALID_JSON" : typeof error?.message === "string" ? error.message.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 64).toUpperCase() : "INVALID_STORE";
        fail(503, "Model settings could not be loaded safely (" + safeCause + "). Verify the private settings and encryption key files.", "MODEL_STORE_UNAVAILABLE");
      }
      return true;
    });
  }
  function list() { ready(); return { providers: providers.map(item => publicProvider(item, activeProviderId)), activeProviderId }; }
  function runtimeConfig() {
    if (!loaded || unavailable || !masterKey) return null;
    if (!providers.length) return null;
    const item = providers.find(provider => provider.id === activeProviderId && provider.enabled && provider.apiKey);
    // No qualified active provider means the caller falls back to the
    // environment configuration. A placeholder object would be truthy and would
    // hide that configuration.
    if (!item) return null;
    return { enabled: true, endpoint: item.endpoint, apiKey: item.apiKey, model: item.model, timeoutMs: 15_000, providerId: item.id, providerName: item.name };
  }
  function runtimeFallbackConfigs() {
    if (!loaded || unavailable || !masterKey) return [];
    return providers
      .filter(provider => provider.id !== activeProviderId && provider.enabled && provider.apiKey && provider.fallback)
      .slice(0, 3)
      .map(item => ({
        enabled: true, endpoint: item.endpoint, apiKey: item.apiKey, model: item.model,
        timeoutMs: 15_000, providerId: item.id, providerName: item.name
      }));
  }
  async function add(input) {
    return series(async () => {
      ready(); const value = validateModelProviderInput(input, { creating: true });
      if (providers.length >= MAX_PROVIDERS) fail(409, "Maximum model provider count reached.", "MODEL_PROVIDER_LIMIT");
      const stamp = now(), item = { id: randomBytes(12).toString("hex"), ...value, apiKey: value.apiKey, createdAt: stamp, updatedAt: stamp, lastTest: null };
      delete item.clearApiKey;
      const oldProviders = providers, oldActive = activeProviderId;
      providers = [...providers, item]; if (!activeProviderId && item.enabled) activeProviderId = item.id;
      try { await persist(); } catch { rollback(oldProviders, oldActive); fail(500, "Unable to save model settings securely.", "MODEL_STORE_WRITE_FAILED"); }
      return publicProvider(item, activeProviderId);
    });
  }
  async function update(idInput, input) {
    return series(async () => {
      ready(); const id = idValue(idInput), existing = providers.find(item => item.id === id);
      if (!existing) fail(404, "Model provider not found.", "MODEL_PROVIDER_NOT_FOUND");
      const value = validateModelProviderInput(input, { currentHasKey: Boolean(existing.apiKey), currentFallback: existing.fallback === true, currentEnabled: existing.enabled === true });
      const apiKey = value.clearApiKey ? "" : value.apiKey || existing.apiKey;
      const updated = { ...existing, name: value.name, endpoint: value.endpoint, model: value.model, apiKey, fallback: value.fallback,
        enabled: value.enabled && Boolean(apiKey), updatedAt: now(),
        lastTest: existing.endpoint === value.endpoint && existing.model === value.model && !value.apiKey && !value.clearApiKey ? existing.lastTest : null };
      const oldProviders = providers, oldActive = activeProviderId;
      providers = providers.map(item => item.id === id ? updated : item);
      // A disabled active provider hands the main slot to another enabled
      // provider, exactly like a removal does.
      if (activeProviderId === id && !updated.enabled) activeProviderId = providers.find(item => item.enabled && item.apiKey)?.id || null;
      try { await persist(); } catch { rollback(oldProviders, oldActive); fail(500, "Unable to save model settings securely.", "MODEL_STORE_WRITE_FAILED"); }
      return publicProvider(updated, activeProviderId);
    });
  }
  async function remove(idInput) {
    return series(async () => {
      ready(); const id = idValue(idInput);
      if (!providers.some(item => item.id === id)) fail(404, "Model provider not found.", "MODEL_PROVIDER_NOT_FOUND");
      const oldProviders = providers, oldActive = activeProviderId;
      providers = providers.filter(item => item.id !== id);
      if (activeProviderId === id) activeProviderId = providers.find(item => item.enabled && item.apiKey)?.id || null;
      try { await persist(); } catch { rollback(oldProviders, oldActive); fail(500, "Unable to save model settings securely.", "MODEL_STORE_WRITE_FAILED"); }
      return { removed: true, activeProviderId };
    });
  }
  async function setDefault(idInput) {
    return series(async () => {
      ready(); const id = idValue(idInput), item = providers.find(provider => provider.id === id);
      if (!item) fail(404, "Model provider not found.", "MODEL_PROVIDER_NOT_FOUND");
      if (!item.enabled || !item.apiKey) fail(409, "Enable this provider and save its API key before setting it as default.", "MODEL_PROVIDER_DISABLED");
      const oldProviders = providers, oldActive = activeProviderId; activeProviderId = id;
      try { await persist(); } catch { rollback(oldProviders, oldActive); fail(500, "Unable to save model settings securely.", "MODEL_STORE_WRITE_FAILED"); }
      return publicProvider(item, activeProviderId);
    });
  }
  async function discoverModels(idInput) {
    ready();
    const id = idValue(idInput), item = providers.find(provider => provider.id === id);
    if (!item) fail(404, "Model provider not found.", "MODEL_PROVIDER_NOT_FOUND");
    if (!item.apiKey) fail(409, "Save an API key before discovering models.", "MODEL_KEY_REQUIRED");
    const catalogUrl = item.endpoint.replace(/\/chat\/completions\/?$/, "/models");
    const started = Date.now();
    try {
      const response = await fetchImpl(catalogUrl, {
        method: "GET",
        headers: { authorization: "Bearer " + item.apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { ok: false, message: errorHint(response.status), statusCode: response.status, models: [], durationMs: Math.max(0, Date.now() - started) };
      }
      let parsed;
      try { parsed = JSON.parse(await responseText(response)); }
      catch (error) {
        if (error?.code === "MODEL_TEST_RESPONSE_TOO_LARGE") throw error;
        return { ok: false, message: "服务商返回的模型列表不是有效 JSON。", statusCode: 502, models: [], durationMs: Math.max(0, Date.now() - started) };
      }
      if (!Array.isArray(parsed?.data)) return { ok: false, message: "服务商未返回兼容 OpenAI 的 data 模型列表。", statusCode: 502, models: [], durationMs: Math.max(0, Date.now() - started) };
      const seen = new Set(), models = [];
      for (const entry of parsed.data) {
        if (!entry || typeof entry.id !== "string") continue;
        const modelId = entry.id.trim();
        if (!modelId || modelId.length > 160 || /[\x00-\x1f\x7f]/.test(modelId) || seen.has(modelId)) continue;
        seen.add(modelId); models.push({ id: modelId, ownedBy: typeof entry.owned_by === "string" ? entry.owned_by.slice(0, 80) : null });
        if (models.length >= 100) break;
      }
      return { ok: true, message: "已读取 " + models.length + " 个模型。", statusCode: 200, models, durationMs: Math.max(0, Date.now() - started) };
    } catch (error) {
      return { ok: false, message: error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "读取模型列表超时，请检查服务商地址和网络。"
        : error?.code === "MODEL_TEST_RESPONSE_TOO_LARGE" ? "服务商返回的模型列表超过大小限制。"
        : "读取模型列表失败，请确认服务商支持 GET /models。", models: [], durationMs: Math.max(0, Date.now() - started) };
    }
  }
  async function test(idInput) {
    return series(async () => {
      ready(); const id = idValue(idInput), item = providers.find(provider => provider.id === id);
      if (!item) fail(404, "Model provider not found.", "MODEL_PROVIDER_NOT_FOUND");
      if (!item.apiKey) fail(409, "Save an API key before testing this provider.", "MODEL_KEY_REQUIRED");
      const started = Date.now(); let result;
      try {
        const response = await fetchImpl(item.endpoint, {
          method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + item.apiKey },
          body: JSON.stringify({ model: item.model, messages: [{ role: "user", content: "Reply with OK." }], temperature: 0, max_tokens: 8 }),
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          result = { ok: false, message: errorHint(response.status), statusCode: response.status };
        } else {
          let parsed = null;
          try { parsed = JSON.parse(await responseText(response)); } catch (error) { if (error?.code === "MODEL_TEST_RESPONSE_TOO_LARGE") throw error; }
          result = parsed && Array.isArray(parsed.choices) && typeof parsed.choices[0]?.message?.content === "string"
            ? { ok: true, message: "连接成功，模型已返回有效响应。", statusCode: 200 }
            : { ok: false, message: "服务商返回格式不符合 OpenAI Chat Completions 协议。", statusCode: 502 };
        }
      } catch (error) {
        result = { ok: false, message: error?.name === "TimeoutError" || error?.name === "AbortError"
          ? "连接测试超时，请检查服务商地址和网络。"
          : error?.code === "MODEL_TEST_RESPONSE_TOO_LARGE" ? "服务商返回内容超过测试上限。"
          : "连接失败，请检查 HTTPS 地址、API Key、模型名称和网络。" };
      }
      const oldProviders = providers, oldActive = activeProviderId;
      const durationMs = Math.max(0, Date.now() - started);
      const updated = { ...item, lastTest: {
        ok: result.ok, at: now(), message: result.message, durationMs,
        ...(result.statusCode ? { statusCode: result.statusCode } : {})
      } };
      providers = providers.map(provider => provider.id === id ? updated : provider);
      try { await persist(); } catch { rollback(oldProviders, oldActive); fail(500, "Test completed but could not save its result.", "MODEL_STORE_WRITE_FAILED"); }
      return { provider: publicProvider(updated, activeProviderId), test: { ...result, durationMs } };
    });
  }
  return Object.freeze({ load, list, runtimeConfig, runtimeFallbackConfigs, add, update, remove, setDefault, test, discoverModels, degraded: () => unavailable === true, status() {
    return { configured: loaded && !unavailable, providerCount: providers.length, activeProviderId };
  } });
}

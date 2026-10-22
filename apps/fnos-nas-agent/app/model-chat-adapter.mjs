// A direct chat channel for the UI ("Marvis style" plain conversation).
//
// This module is deliberately separate from the planning adapter: plan() is
// the safety boundary of the agent, where every tool call must pass the
// registered inputSchema. A chat turn is plain text, so it must not be able to
// reach that contract by accident, and it must not be able to weaken it
// either. The two channels therefore share the transport rules (endpoint
// whitelist, bearer key, bounded body, error vocabulary) and nothing else.
import { modelConfiguration } from "./model-adapter.mjs";
import { validateModelProviderInput } from "./model-provider-store.mjs";

const MAX_CHAT_MESSAGES = 32;
const MAX_CHAT_CONTENT_LENGTH = 2000;
// The chat stream is allowed to be a little larger than one plan envelope
// because it carries a whole conversation, but it stays in the same order of
// magnitude as the plan adapter's MAX_RESPONSE_BYTES.
const MAX_CHAT_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_CHAT_TIMEOUT_MS = 15_000;
const MIN_CHAT_TIMEOUT_MS = 1_000;
const MAX_CHAT_TIMEOUT_MS = 120_000;
const CHAT_TEMPERATURE = 0.2;
const CHAT_MAX_TOKENS = 1200;
const ALLOWED_ROLES = new Set(["user", "assistant", "system"]);

function chatError(code, message, options = {}) {
  return Object.assign(new Error(message), { code, ...options });
}
function invalidRequest(message) {
  return chatError("MODEL_CHAT_INVALID_REQUEST", message, {
    statusCode: 400, category: "INVALID_REQUEST", retryable: false, fallbackEligible: false
  });
}
function abortedError() {
  return chatError("MODEL_CHAT_ABORTED", "对话已被取消。", {
    statusCode: 499, category: "CANCELLED", retryable: false, fallbackEligible: false
  });
}
function invalidResponseError(message) {
  return chatError("MODEL_CHAT_INVALID_RESPONSE", message, {
    statusCode: 502, category: "INVALID_RESPONSE", retryable: true, fallbackEligible: false
  });
}
function tooLargeError() {
  return chatError("MODEL_CHAT_RESPONSE_TOO_LARGE", "模型服务商的流式响应超过大小上限。", {
    statusCode: 502, category: "RESPONSE_TOO_LARGE", retryable: false, fallbackEligible: false
  });
}
function upstreamError(message, statusCode, category = "UPSTREAM_ERROR") {
  return chatError("MODEL_CHAT_UPSTREAM_ERROR", message, {
    statusCode, category, retryable: false, fallbackEligible: false
  });
}
function retryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}
function upstreamStatusCategory(status) {
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "PROVIDER_SERVER_ERROR";
  if (status === 401 || status === 403) return "PROVIDER_AUTH_ERROR";
  if (status === 404) return "PROVIDER_NOT_FOUND";
  return "PROVIDER_HTTP_ERROR";
}
// The endpoint whitelist is not re-implemented here. It is the transport rule
// of the whole product, so the two existing implementations are applied:
//   1. model-adapter.mjs safeEndpoint() - reached through the exported
//      modelConfiguration(): HTTPS only, plain HTTP only on loopback, no
//      userinfo and no fragment.
//   2. model-provider-store.mjs endpoint() - reached through the exported
//      validateModelProviderInput(): no query string, no fragment, and the
//      path has to end with /chat/completions.
// A chat request to an endpoint that is not on that list never leaves the
// process.
function safeChatEndpoint(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const viaModelAdapter = modelConfiguration({
    AGENT_MODEL_ENABLED: "true",
    AGENT_MODEL_ENDPOINT: value,
    AGENT_MODEL_API_KEY: "endpoint-check",
    AGENT_MODEL_NAME: "endpoint-check"
  }).endpoint;
  if (!viaModelAdapter) return null;
  try {
    const validated = validateModelProviderInput({
      name: "endpoint-check",
      endpoint: viaModelAdapter,
      model: "endpoint-check",
      apiKey: "endpoint-check"
    }, { creating: true });
    return validated.endpoint;
  } catch {
    return null;
  }
}
function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) throw invalidRequest("对话消息必须是非空数组。");
  if (messages.length > MAX_CHAT_MESSAGES) throw invalidRequest("对话消息不能超过 " + MAX_CHAT_MESSAGES + " 条。");
  return messages.map((item, index) => {
    const position = "第 " + (index + 1) + " 条消息";
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalidRequest(position + "必须是对象。");
    if (!ALLOWED_ROLES.has(item.role)) throw invalidRequest(position + "的 role 只能是 user、assistant 或 system。");
    if (typeof item.content !== "string" || !item.content.trim()) throw invalidRequest(position + "的内容不能为空。");
    if (item.content.length > MAX_CHAT_CONTENT_LENGTH) throw invalidRequest(position + "的内容不能超过 " + MAX_CHAT_CONTENT_LENGTH + " 个字符。");
    return { role: item.role, content: item.content };
  });
}
// A cancelled turn is neither a provider problem nor a network problem.
function classifyTransportError(error, signal) {
  if (signal?.aborted) return abortedError();
  const name = error?.name || error?.signal?.reason?.name || error?.cause?.name;
  if (name === "TimeoutError") {
    return chatError("MODEL_CHAT_TIMEOUT", "模型服务商响应超时。", {
      statusCode: 504, category: "TIMEOUT", retryable: true, fallbackEligible: false
    });
  }
  if (name === "AbortError") return abortedError();
  return chatError("MODEL_CHAT_NETWORK_ERROR", "无法连接模型服务商，请检查地址与网络。", {
    statusCode: 502, category: "NETWORK_ERROR", retryable: true, fallbackEligible: false
  });
}

export function createModelChatAdapter({ providerStore, fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (!providerStore || typeof providerStore.runtimeConfig !== "function") throw new TypeError("providerStore must expose runtimeConfig()");
  if (typeof fetchImpl !== "function" || typeof now !== "function") throw new TypeError("Invalid model chat adapter dependency");

  function currentConfig() {
    let config = null;
    try { config = providerStore.runtimeConfig(); }
    catch { config = null; }
    return config && typeof config === "object" ? config : null;
  }
  function usableConfig(config) {
    return Boolean(config && typeof config.endpoint === "string" && config.endpoint &&
      typeof config.apiKey === "string" && config.apiKey && typeof config.model === "string" && config.model);
  }
  // One reader for the whole stream. The line grammar is the OpenAI one:
  // "data: <json>" per line, "[DONE]" closes the stream.
  async function readChatStream(response, { onDelta, signal }) {
    const reader = response.body && typeof response.body.getReader === "function" ? response.body.getReader() : null;
    let full = "", sawContent = false, finished = false, size = 0;

    const handleData = async payload => {
      const data = payload.trim();
      if (!data) return;
      if (data === "[DONE]") { finished = true; return; }
      let envelope = null;
      try { envelope = JSON.parse(data); }
      catch { throw invalidResponseError("模型服务商返回了无法解析的流式数据。"); }
      if (envelope && typeof envelope === "object" && envelope.error) {
        const detail = typeof envelope.error.message === "string" ? envelope.error.message.slice(0, 200) : "上游返回了错误";
        throw upstreamError("模型服务商返回错误：" + detail, 502);
      }
      const delta = envelope?.choices?.[0]?.delta?.content;
      // A provider that ignores stream:true answers with one complete message.
      const fallback = envelope?.choices?.[0]?.message?.content;
      const chunk = typeof delta === "string" ? delta : (typeof fallback === "string" ? fallback : "");
      if (!chunk) return;
      full += chunk;
      sawContent = true;
      if (typeof onDelta === "function") await onDelta(chunk);
    };
    const handleLine = async line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) return;
      if (!trimmed.startsWith("data:")) return;
      await handleData(trimmed.slice("data:".length));
    };

    if (!reader) {
      const raw = typeof response.text === "function" ? await response.text() : "";
      size = Buffer.byteLength(raw, "utf8");
      if (size > MAX_CHAT_RESPONSE_BYTES) throw tooLargeError();
      for (const line of raw.split(/\r?\n/)) {
        await handleLine(line);
        if (finished) break;
      }
    } else {
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_CHAT_RESPONSE_BYTES) {
            await reader.cancel().catch(() => {});
            throw tooLargeError();
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            await handleLine(line);
            if (finished) break;
          }
          if (finished) {
            await reader.cancel().catch(() => {});
            break;
          }
        }
        if (!finished) {
          buffer += decoder.decode();
          if (buffer.trim()) await handleLine(buffer);
        }
      } catch (error) {
        if (error?.code && String(error.code).startsWith("MODEL_CHAT_")) throw error;
        throw classifyTransportError(error, signal);
      } finally {
        try { reader.releaseLock?.(); } catch { /* the stream is already closed */ }
      }
    }
    if (!sawContent) throw invalidResponseError("模型服务商没有返回任何内容。");
    return full;
  }

  async function chat({ messages, signal, onDelta } = {}) {
    if (signal && typeof signal.aborted === "boolean" && signal.aborted) throw abortedError();
    const normalized = normalizeMessages(messages);
    const config = currentConfig();
    if (!usableConfig(config)) {
      throw chatError("MODEL_CHAT_NOT_CONFIGURED",
        "尚未配置可用的模型服务商。请在“模型与供应商”页面添加并启用一个已保存密钥的供应商后再开始对话。", {
        statusCode: 502, category: "NOT_CONFIGURED", retryable: false, fallbackEligible: false
      });
    }
    const endpoint = safeChatEndpoint(config.endpoint);
    if (!endpoint) {
      throw chatError("MODEL_CHAT_INVALID_ENDPOINT",
        "模型服务商地址不在安全白名单内：只允许 HTTPS，或 localhost / 127.0.0.1 / [::1] 上的 HTTP，且路径必须以 /chat/completions 结尾。", {
        statusCode: 400, category: "INVALID_ENDPOINT", retryable: false, fallbackEligible: false
      });
    }
    const timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs >= MIN_CHAT_TIMEOUT_MS && config.timeoutMs <= MAX_CHAT_TIMEOUT_MS
      ? config.timeoutMs : DEFAULT_CHAT_TIMEOUT_MS;
    const startedAt = now();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal && typeof signal.aborted === "boolean" ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response = null;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: "Bearer " + config.apiKey
        },
        body: JSON.stringify({
          model: config.model,
          temperature: CHAT_TEMPERATURE,
          max_tokens: CHAT_MAX_TOKENS,
          stream: true,
          messages: normalized
        }),
        signal: requestSignal
      });
    } catch (error) {
      if (error?.code && String(error.code).startsWith("MODEL_CHAT_")) throw error;
      const classified = classifyTransportError(error, signal);
      if (classified.code === "MODEL_CHAT_TIMEOUT") {
        classified.message = "模型服务商响应超时（" + Math.max(0, now() - startedAt) + " ms）。";
      }
      throw classified;
    }
    if (!response || typeof response !== "object") throw invalidResponseError("模型服务商没有返回响应。");
    if (response.ok === false) {
      const status = Number.isInteger(response.status) ? response.status : 502;
      try { await response.body?.cancel?.(); } catch { /* the body is not important here */ }
      const failure = upstreamError("模型服务商拒绝了请求（HTTP " + status + "）。", status, upstreamStatusCategory(status));
      failure.retryable = retryableStatus(status);
      throw failure;
    }
    return readChatStream(response, { onDelta, signal });
  }

  return Object.freeze({
    chat,
    status() {
      const config = currentConfig();
      const configured = usableConfig(config);
      return {
        // The chat channel is only enabled when the endpoint is on the
        // whitelist as well, because an unusable endpoint cannot serve a turn.
        enabled: configured && Boolean(safeChatEndpoint(config.endpoint)),
        providerConfigured: configured,
        model: configured ? config.model : null,
        providerId: configured ? (config.providerId || null) : null,
        providerName: configured ? (config.providerName || null) : null
      };
    }
  });
}

/**
 * Phase 175 — 受控网页抓取实现（模块 06「受控 Web 取证」的最后一环）
 *
 * Phase 172 交付了网络策略（`app/network-policy.mjs`）与证据转换
 * （`app/web-evidence.mjs`），但没有真正发起请求的能力，B01 仍然是
 * "有策略无能力"。本模块补上这一环：把一个**被策略允许**的 URL 抓下来，
 * 并转成受控证据。
 *
 * 执行顺序是硬约束：**先判定，后出网**。判定不通过就一个字节都不发。
 *
 * 红线：
 *   - **策略先行**：每一跳（含每一���重定向）都必须先过 `policy.isUrlAllowed`；
 *   - **最小请求头**：只发 `Accept`，绝不发 Cookie / Authorization / 任何凭据；
 *   - **有界**：响应体按字节上限截断，整体超时真的中断请求；
 *   - **不外泄**：请求头、响应头（含 set-cookie）、原始 HTML 全文都不进证据，
 *     错误信息里也不出现凭据；
 *   - 清洗与脱敏交给 `web-evidence.mjs`，本模块不另写一份。
 */

import http from "node:http";
import https from "node:https";
import { Buffer } from "node:buffer";

import { buildWebEvidence } from "./web-evidence.mjs";

/** 默认响应体上限：2 MiB。 */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** 默认整体超时：10 秒。 */
export const DEFAULT_TIMEOUT_MS = 10000;

/** 默认最大重定向跳数。 */
export const DEFAULT_MAX_REDIRECTS = 3;

/** 固定请求头集合：只有 Accept，没有任何凭据。 */
export const REQUEST_HEADERS = Object.freeze({
  Accept: "text/html,application/xhtml+xml,text/plain"
});

/** 允许的响应内容类型。 */
export const ALLOWED_CONTENT_TYPES = Object.freeze([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "application/json"
]);

/** 触发重定向的状态码。 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 把 URL 里的凭据抹掉，只用于报错与判定回显。
 *
 * @param {string} url
 * @returns {string}
 */
export function sanitizeUrlForReport(url) {
  const raw = text(url);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return raw.replace(/\/\/[^/@]*@/, "//");
  }
}

/**
 * 构造一个不带凭据的判定副本。
 *
 * @param {object|null} decision
 * @returns {object|null}
 */
function sanitizedDecision(decision) {
  if (!decision || typeof decision !== "object") return null;
  const copy = { ...decision };
  copy.url = sanitizeUrlForReport(decision.url ?? "");
  copy.normalizedUrl = sanitizeUrlForReport(decision.normalizedUrl ?? "");
  copy.host = text(decision.host);
  return copy;
}

/**
 * 规范化响应头访问（fetch 的 Headers 与 node 的 IncomingMessage 头不同）。
 *
 * @param {object} headers
 * @returns {(name: string) => string}
 */
function headerReader(headers) {
  if (!headers) return () => "";
  if (typeof headers.get === "function") {
    return name => text(headers.get(name));
  }
  const lower = new Map();
  for (const [key, value] of Object.entries(headers)) {
    if (key) lower.set(String(key).toLowerCase(), Array.isArray(value) ? text(value[0]) : text(value));
  }
  return name => lower.get(String(name).toLowerCase()) ?? "";
}

/**
 * 读取响应体，超过上限就截断并停止累积。
 *
 * @param {AsyncIterable<Uint8Array>|null} source
 * @param {number} limit
 * @param {() => void} [onLimit]
 * @returns {Promise<{buffer: Buffer, truncated: boolean, bytes: number}>}
 */
async function readLimited(source, limit, onLimit) {
  const chunks = [];
  let total = 0;
  let truncated = false;
  if (source) {
    for await (const chunk of source) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (total + bytes.length > limit) {
        const room = Math.max(0, limit - total);
        if (room > 0) chunks.push(bytes.subarray(0, room));
        total += bytes.length;
        truncated = true;
        if (typeof onLimit === "function") onLimit();
        break;
      }
      chunks.push(bytes);
      total += bytes.length;
    }
  }
  return { buffer: Buffer.concat(chunks), truncated, bytes: total };
}

/**
 * 把 web ReadableStream 包装成异步迭代器。
 *
 * @param {ReadableStream|null} stream
 * @returns {AsyncGenerator<Uint8Array>|null}
 */
async function* streamChunks(stream) {
  if (!stream) return;
  if (typeof stream.getReader === "function") {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        /* 忽略：读锁已释放 */
      }
    }
    return;
  }
  if (typeof stream[Symbol.asyncIterator] === "function") {
    for await (const chunk of stream) yield chunk;
  }
}

/**
 * 用 node:http / node:https 发起一次真实请求。
 *
 * @param {string} url
 * @param {{headers: object, signal: AbortSignal}} options
 * @returns {Promise<{status: number, headers: object, body: AsyncIterable<Uint8Array>, destroy: () => void}>}
 */
function nodeRequest(url, { headers, signal }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(new Error(`URL 无法解析：${error?.message || "unknown error"}`));
      return;
    }
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(target, { method: "GET", headers, agent: false }, response => {
      // 提前中止时响应流可能报错，这里吞掉，避免变成未处理异常。
      response.on("error", () => {});
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: response,
        destroy: () => request.destroy()
      });
    });
    request.on("error", error => reject(error));
    const onAbort = () => {
      request.destroy(new Error("请求已中断"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    request.end();
  });
}

/**
 * 创建受控网页抓取器。
 *
 * @param {object} options
 * @param {object} options.policy `network-policy.mjs` 产生的策略对象（必须提供 isUrlAllowed）
 * @param {Function} [options.fetchImpl] 注入的 fetch 实现（测试用）；缺省走 node:http / node:https
 * @param {number} [options.maxBytes] 响应体字节上限
 * @param {number} [options.timeoutMs] 整体超时（毫秒）
 * @param {number} [options.maxRedirects] 最大重定向跳数
 * @param {() => number} [options.now] 时钟
 * @returns {{fetchEvidence: Function, settings: Function}}
 */
export function createWebFetcher({
  policy,
  fetchImpl = null,
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  now = () => Date.now()
} = {}) {
  if (!policy || typeof policy.isUrlAllowed !== "function") {
    throw new TypeError("createWebFetcher 需要 policy（必须提供 isUrlAllowed）");
  }

  /**
   * 构造失败结果。
   *
   * @param {string} code
   * @param {string} message
   * @param {object} [extra]
   * @returns {object}
   */
  function failure(code, message, extra = {}) {
    return {
      ok: false,
      evidence: null,
      status: extra.status ?? null,
      policy: {
        allowed: extra.allowed ?? false,
        decision: sanitizedDecision(extra.decision ?? null)
      },
      error: {
        code,
        message,
        reason: extra.reason ?? "",
        url: sanitizeUrlForReport(extra.url ?? "")
      }
    };
  }

  /**
   * 抓取一个 URL 并转成证据。
   *
   * @param {string} url
   * @param {{fetchedAt?: string}} [options]
   * @returns {Promise<{ok: boolean, evidence: object|null, policy: object, status?: number, error?: object}>}
   */
  async function fetchEvidence(url, { fetchedAt = "" } = {}) {
    const rawUrl = text(url);
    if (!rawUrl) {
      return failure("invalid-url", "URL 为空", { url: rawUrl });
    }

    // 1) 策略先行：不允许就一个字节都不发。
    let decision = await policy.isUrlAllowed(rawUrl);
    if (!decision.allowed) {
      return failure("network-url-not-allowed", `网络出口被拒绝（${decision.reason}）：${decision.detail || ""}`, {
        allowed: false,
        decision,
        reason: decision.reason,
        url: rawUrl
      });
    }

    const controller = new AbortController();
    const deadline = now() + timeoutMs;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, timeoutMs));
    // 刻意不 unref：超时必须真的把挂起的请求打断，事件循环要保持存活直到定时器触发。

    let currentUrl = rawUrl;
    let redirects = 0;

    try {
      for (;;) {
        if (now() > deadline) {
          return failure("fetch-timeout", `抓取超时（${timeoutMs} ms）`, { allowed: true, decision, url: currentUrl });
        }

        let response = null;
        try {
          response = await requestOnce(currentUrl, controller.signal);
        } catch (error) {
          if (timedOut) {
            return failure("fetch-timeout", `抓取超时（${timeoutMs} ms）`, { allowed: true, decision, url: currentUrl });
          }
          if (controller.signal.aborted) {
            return failure("fetch-aborted", "抓取被中断", { allowed: true, decision, url: currentUrl });
          }
          return failure("fetch-failed", `抓取失败：${error?.message || "unknown error"}`, {
            allowed: true,
            decision,
            url: currentUrl
          });
        }
        if (timedOut) {
          return failure("fetch-timeout", `抓取超时（${timeoutMs} ms）`, { allowed: true, decision, url: currentUrl });
        }

        const status = response.status;
        const readHeader = headerReader(response.headers);
        const location = readHeader("location");
        const contentType = readHeader("content-type");

        if (REDIRECT_STATUSES.has(status) && location) {
          let nextUrl = "";
          try {
            nextUrl = new URL(location, currentUrl).toString();
          } catch {
            return failure("invalid-redirect", `重定向目标无法解析：${sanitizeUrlForReport(location)}`, {
              allowed: true,
              decision,
              status,
              url: currentUrl
            });
          }

          // 2) 每一跳都重新判定——跳到私网也必须被拒。
          const nextDecision = await policy.isUrlAllowed(nextUrl);
          if (!nextDecision.allowed) {
            return failure("network-url-not-allowed", `重定向目标被拒绝（${nextDecision.reason}）：${nextDecision.detail || ""}`, {
              allowed: false,
              decision: nextDecision,
              reason: nextDecision.reason,
              status,
              url: nextUrl
            });
          }
          if (redirects >= maxRedirects) {
            return failure("too-many-redirects", `重定向次数超过上限（${maxRedirects}）`, {
              allowed: true,
              decision,
              status,
              url: currentUrl
            });
          }
          redirects += 1;
          currentUrl = nextUrl;
          decision = nextDecision;
          continue;
        }

        if (REDIRECT_STATUSES.has(status) && !location) {
          return failure("invalid-redirect", "重定向响应缺少 Location 头", {
            allowed: true,
            decision,
            status,
            url: currentUrl
          });
        }

        // 3) 内容类型闸门：只接受文本类。
        const mime = text(contentType).split(";")[0].trim().toLowerCase();
        if (!mime) {
          return failure("missing-content-type", "响应缺少 Content-Type，拒绝按未知类型解析", {
            allowed: true,
            decision,
            status,
            url: currentUrl
          });
        }
        if (!ALLOWED_CONTENT_TYPES.includes(mime)) {
          return failure("unsupported-content-type", `响应类型 ${mime} 不在允许列表中（${ALLOWED_CONTENT_TYPES.join(", ")}）`, {
            allowed: true,
            decision,
            status,
            url: currentUrl
          });
        }

        // 4) 有界读取：字节上限与整体超时。
        let body;
        try {
          body = await readLimited(response.body, maxBytes, () => {
            controller.abort();
          });
        } catch (error) {
          if (timedOut) {
            return failure("fetch-timeout", `抓取超时（${timeoutMs} ms）`, { allowed: true, decision, status, url: currentUrl });
          }
          return failure("fetch-failed", `读取响应体失败：${error?.message || "unknown error"}`, {
            allowed: true,
            decision,
            status,
            url: currentUrl
          });
        }

        // 5) 交给 web-evidence 做清洗与脱敏，本模块不另写一份。
        const raw = buildWebEvidence({
          url: currentUrl,
          status,
          contentType: mime,
          body: body.buffer.toString("utf8"),
          fetchedAt: text(fetchedAt) || new Date(now()).toISOString(),
          policyDecision: { allowed: true, reason: decision.reason ?? "allowed" }
        });
        const evidence = {
          ...raw,
          // 字节上限截断与文本截断是两回事，两个标记都留着。
          truncated: raw.truncated === true || body.truncated,
          bodyTruncated: body.truncated
        };

        return {
          ok: true,
          evidence,
          status,
          truncated: body.truncated,
          policy: { allowed: true, decision: sanitizedDecision(decision) },
          error: null
        };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 发起一次请求（注入 fetchImpl 或真实 node 请求）。
   *
   * @param {string} url
   * @param {AbortSignal} signal
   * @returns {Promise<{status: number, headers: object, body: AsyncIterable<Uint8Array>}>}
   */
  async function requestOnce(url, signal) {
    if (typeof fetchImpl === "function") {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { ...REQUEST_HEADERS },
        signal,
        redirect: "manual"
      });
      const status = Number(response?.status ?? 0);
      const headers = response?.headers ?? null;
      const body = response?.body ? streamChunks(response.body) : null;
      return { status, headers, body };
    }
    return nodeRequest(url, { headers: { ...REQUEST_HEADERS }, signal });
  }

  /**
   * 当前配置快照。
   *
   * @returns {object}
   */
  function settings() {
    return Object.freeze({
      maxBytes,
      timeoutMs,
      maxRedirects,
      requestHeaders: Object.freeze({ ...REQUEST_HEADERS }),
      allowedContentTypes: Object.freeze([...ALLOWED_CONTENT_TYPES]),
      injectedFetch: typeof fetchImpl === "function"
    });
  }

  return Object.freeze({ fetchEvidence, settings });
}

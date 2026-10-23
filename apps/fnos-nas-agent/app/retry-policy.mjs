/**
 * Phase 215 — 失败重试的判定层（纯函数 + 一个有界的包装器）。
 *
 * 这一层只回答三个问题：
 *   1. 这个错误值不值得重试？（classifyFailure）
 *   2. 这次失败之后还应不应该再来一次？间隔多久？（decideRetry）
 *   3. 怎么把一个只读调用包成「可重试」的？（createRetryingInvoker）
 *
 * 红线：
 *   - 只重试「只读」动作。写与破坏性动作一旦失败就必须让人看见，不能被悄悄重放。
 *   - 不猜：认不出的错误一律不重试（retry=false），理由写成 unknown-error。
 *   - 不睡眠在模块里：间隔交给调用方注入的 sleep，测试可以零等待。
 *   - 不记录参数与错误原文以外的信息；重试记录只保留工具名、第几次、原因。
 */

/** 值得重试的错误特征：超时、连接类故障、上游暂时不可用（429/502/503/504）。 */
const TRANSIENT_PATTERNS = Object.freeze([
  /\btimed?\s*out\b/i,
  /\bETIMEDOUT\b/,
  /\bESOCKETTIMEDOUT\b/,
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bECONNABORTED\b/,
  /\bEAI_AGAIN\b/,
  /\bEPIPE\b/,
  /\bENETUNREACH\b/,
  /\bEHOSTUNREACH\b/,
  /\bsocket hang up\b/i,
  /\bnetwork\b.*\bunreachable\b/i,
  /\bservice unavailable\b/i,
  /\btoo many requests\b/i,
  /\brate limit/i
]);

/** 明确不该重试的信号：策略拒绝、认证失效、参数错误、对象不存在、被取消。 */
const PERMANENT_PATTERNS = Object.freeze([
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /\bpolicy-denied\b/i,
  /\bnot allowed\b/i,
  /\binvalid\b/i,
  /\bbad request\b/i,
  /\bnot found\b/i,
  /\bunknown tool\b/i,
  /\bcancell?ed\b/i,
  /\baborted\b/i,
  /\bapproval[- ]denied\b/i
]);

/** 这些 HTTP 状态码代表「过一会儿可能就好」。 */
const TRANSIENT_STATUS = Object.freeze([408, 425, 429, 500, 502, 503, 504]);

/** 这些 HTTP 状态码代表「再来一百次也一样」。 */
const PERMANENT_STATUS = Object.freeze([400, 401, 403, 404, 405, 409, 413, 415, 422]);

/** 默认参数。 */
export const RETRY_DEFAULTS = Object.freeze({
  maxAttempts: 2,
  baseDelayMs: 250,
  maxDelayMs: 4000
});

/** 允许的上限：任何来源的尝试次数都被夹在这里。 */
export const MAX_RETRY_ATTEMPTS = 3;

function readProperty(value, key) {
  if (value && typeof value === "object" && key in value) return value[key];
  return undefined;
}

/**
 * 把任意抛出的值收敛成「类别 + 状态码 + 消息」。
 * 绝不把原始对象透传出去，避免把请求体之类的东西带进日志。
 */
export function describeFailure(error) {
  const message = String(readProperty(error, "message") ?? error ?? "").trim();
  const causeCode = String(readProperty(readProperty(error, "cause"), "code") ?? "").trim();
  const code = String(readProperty(error, "code") ?? causeCode ?? "").trim();
  const rawStatus = readProperty(error, "statusCode") ?? readProperty(error, "status") ?? readProperty(error, "status_code");
  const status = Number.isFinite(Number(rawStatus)) && String(rawStatus).trim() !== "" ? Number(rawStatus) : null;
  const name = String(readProperty(error, "name") ?? "").trim();
  return { message: message.slice(0, 200), code, status, name };
}

/**
 * 判定一次失败的类别。
 * kind ∈ transient / permanent / unknown；只有 transient 才值得重试。
 */
export function classifyFailure(error) {
  const described = describeFailure(error);
  if (described.name === "AbortError") return { kind: "permanent", reason: "aborted", ...described };
  if (described.status !== null) {
    if (PERMANENT_STATUS.includes(described.status)) return { kind: "permanent", reason: `http-${described.status}`, ...described };
    if (TRANSIENT_STATUS.includes(described.status)) return { kind: "transient", reason: `http-${described.status}`, ...described };
    if (described.status >= 500) return { kind: "transient", reason: `http-${described.status}`, ...described };
    if (described.status >= 400) return { kind: "permanent", reason: `http-${described.status}`, ...described };
  }
  const haystack = `${described.code} ${described.message}`;
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return { kind: "permanent", reason: "permanent-signal", ...described };
  }
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return { kind: "transient", reason: "transient-signal", ...described };
  }
  return { kind: "unknown", reason: "unknown-error", ...described };
}

/** 指数退避，夹到 maxDelayMs；attempt 从 1 开始。 */
export function computeBackoff(attempt, { baseDelayMs = RETRY_DEFAULTS.baseDelayMs, maxDelayMs = RETRY_DEFAULTS.maxDelayMs } = {}) {
  const step = Math.max(1, Math.trunc(Number(attempt) || 1));
  const base = Math.max(0, Number(baseDelayMs) || 0);
  const cap = Math.max(base, Number(maxDelayMs) || base);
  return Math.min(cap, base * 2 ** (step - 1));
}

/**
 * 决定「还要不要再试一次」。
 * risk 必须是工具登记的风险等级；只有 read-only 允许重试。
 */
export function decideRetry(input = {}) {
  const attempt = Math.max(1, Math.trunc(Number(input.attempt) || 1));
  const maxAttempts = Math.min(MAX_RETRY_ATTEMPTS, Math.max(1, Math.trunc(Number(input.maxAttempts) || 1)));
  const risk = String(input.risk ?? "");
  const failure = input.failure ?? classifyFailure(input.error);

  if (attempt >= maxAttempts) return { retry: false, delayMs: 0, reason: "attempts-exhausted", kind: failure.kind };
  if (risk !== "read-only") return { retry: false, delayMs: 0, reason: "not-read-only", kind: failure.kind };
  if (failure.kind !== "transient") return { retry: false, delayMs: 0, reason: failure.kind === "permanent" ? "permanent-failure" : "unknown-error", kind: failure.kind };
  return {
    retry: true,
    delayMs: computeBackoff(attempt, { baseDelayMs: input.baseDelayMs, maxDelayMs: input.maxDelayMs }),
    reason: failure.reason,
    kind: failure.kind
  };
}

/**
 * 把一次只读调用包成「有界可重试」。
 *
 * @param {object} options
 * @param {(request: object) => Promise<unknown>} options.invoke 真正的调用
 * @param {(tool: string) => string|null} [options.resolveRisk] 查工具风险等级；拿不到就视为不可重试
 * @param {number} [options.maxAttempts] 总尝试次数（含第一次），夹在 1..MAX_RETRY_ATTEMPTS
 * @param {(ms: number) => Promise<void>} [options.sleep] 等待实现，默认 setTimeout
 * @param {(record: object) => void} [options.onRetry] 每次重试前的回调（只给工具名、第几次、原因）
 */
export function createRetryingInvoker(options = {}) {
  const invoke = options.invoke;
  if (typeof invoke !== "function") throw new TypeError("createRetryingInvoker requires invoke");
  const resolveRisk = typeof options.resolveRisk === "function" ? options.resolveRisk : () => null;
  const maxAttempts = Math.min(MAX_RETRY_ATTEMPTS, Math.max(1, Math.trunc(Number(options.maxAttempts) || 1)));
  const baseDelayMs = Number.isFinite(Number(options.baseDelayMs)) ? Number(options.baseDelayMs) : RETRY_DEFAULTS.baseDelayMs;
  const maxDelayMs = Number.isFinite(Number(options.maxDelayMs)) ? Number(options.maxDelayMs) : RETRY_DEFAULTS.maxDelayMs;
  const sleep = typeof options.sleep === "function"
    ? options.sleep
    : (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); if (typeof timer?.unref === "function") timer.unref(); });
  const onRetry = typeof options.onRetry === "function" ? options.onRetry : () => {};
  const records = [];

  return {
    /** 累计的重试记录（只读拷贝）。 */
    retries() {
      return records.map((entry) => ({ ...entry }));
    },
    async run(request) {
      const tool = String(request?.tool ?? "");
      const risk = (() => {
        try { return resolveRisk(tool) ?? null; } catch { return null; }
      })();
      for (let attempt = 1; ; attempt += 1) {
        try {
          const value = await invoke(request);
          return { value, attempts: attempt, retried: attempt > 1 };
        } catch (error) {
          const failure = classifyFailure(error);
          const decision = decideRetry({ attempt, maxAttempts, risk, failure, baseDelayMs, maxDelayMs });
          if (!decision.retry) throw error;
          const record = { tool, attempt, nextAttempt: attempt + 1, delayMs: decision.delayMs, reason: decision.reason };
          records.push(record);
          onRetry(record);
          await sleep(decision.delayMs);
        }
      }
    }
  };
}

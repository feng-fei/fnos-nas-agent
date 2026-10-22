// Phase 155: the wiring layer between a real tool call and the trace.
//
// Phase 146 built the trace: a tracer that records what a tool call was, how
// long it took and how it ended, without ever keeping an argument, a result or
// a raw error. The tracer was able to do that, but nothing called it: the
// built-in tools, the agent plan and the external (MCP) tools all ran without
// a trace entry.
//
// This module is the missing piece. It is deliberately small and deliberately
// passive: it wraps a call, it observes what happened, it writes one terminal
// record per call and it never changes the behaviour of the call it observes.
//
// Three rules govern everything below:
//
//   1. One call, one terminal record. Every observed call ends with exactly
//      one record, whatever happens inside it: success, a returned failure
//      object, a thrown error, a policy denial or a timeout. A record is never
//      left half written.
//   2. No payload, ever. The arguments are reduced to a size and an
//      irreversible fingerprint, the result to a size, the error to a fixed
//      classification code. No prompt, no argument value, no credential, no
//      error message and no stack trace reaches a record or a log line.
//   3. Observation never breaks the call. A broken tracer, a broken logger or
//      a broken clock is swallowed. The observed call keeps its own result and
//      its own error.
import { createHash } from "node:crypto";
import { classifyToolError } from "./tool-trace.mjs";

/**
 * The terminal state of an observed call. The vocabulary is fixed: a record
 * always carries one of these four values, so a consumer never has to guess
 * whether a call is still running.
 */
export const OBSERVER_STATUSES = Object.freeze(["ok", "error", "denied", "timeout"]);

/**
 * The error vocabulary of an observed call. The codes are deliberately coarse:
 * they answer "what kind of failure was this" and nothing more. The raw error
 * message, the stack and the upstream body stay where they are.
 */
export const OBSERVER_ERROR_CODES = Object.freeze([
  "invalid_args",
  "tool_denied",
  "timeout",
  "not_found",
  "model_failure",
  "upstream_error",
  "cancelled",
  "tool_error",
  "unknown"
]);

const DEFAULT_MAX_RECORDS = 500;
const MAX_TEXT_LENGTH = 256;
const MAX_ID_LENGTH = 128;
const MAX_SOURCE_LENGTH = 64;
const FINGERPRINT_LENGTH = 16;
const RISKS = new Set(["read-only", "write", "destructive"]);

// A value that looks like a credential never reaches a record or a log line,
// no matter which field it sits in.
const REDACTED = "[redacted]";
const SECRET_VALUE_PATTERNS = Object.freeze([
  /^(?:sk|pk|rk|api)[-_][A-Za-z0-9_-]{12,}$/i,
  /^(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{12,}$/i,
  /^xox[baprs]-[A-Za-z0-9-]{8,}$/i,
  /^AKIA[0-9A-Z]{12,}$/,
  /^AIza[0-9A-Za-z_-]{16,}$/,
  /^Bearer\s+\S{8,}$/i,
  /^(?:[A-Za-z0-9+/]{40,}={0,2})$/,
  /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{20,}$/,
  /(?:password|passwd|pwd|token|api[_-]?key|secret|credential)\s*[:=]\s*\S{4,}/i
]);

// The codes of a model or provider failure. They are separated from the
// generic upstream failure, because a model that refuses an answer is a
// different operational problem than a service that is down.
const MODEL_FAILURE_CODES = new Set([
  "MODEL_FAILURE",
  "MODEL_UNAVAILABLE",
  "MODEL_PROVIDER_ERROR",
  "PROVIDER_ERROR",
  "MODEL_ERROR"
]);

// The error codes that other modules already use. They are mapped onto the
// observer vocabulary so that a rejection of the execution policy and a
// rejection of the permission policy look the same in the trace.
const CODE_ALIASES = Object.freeze({
  invalid_args: "invalid_args",
  "invalid-args": "invalid_args",
  invalid_arguments: "invalid_args",
  "validation-error": "invalid_args",
  validation_error: "invalid_args",
  bad_request: "invalid_args",
  tool_denied: "tool_denied",
  "tool-denied": "tool_denied",
  "policy-denied": "tool_denied",
  policy_denied: "tool_denied",
  "approval-required": "tool_denied",
  "missing-capability": "tool_denied",
  "read-only-mode": "tool_denied",
  "kill-switch": "tool_denied",
  permission_denied: "tool_denied",
  eacces: "tool_denied",
  eperm: "tool_denied",
  timeout: "timeout",
  etimedout: "timeout",
  esockettimedout: "timeout",
  timeout_error: "timeout",
  not_found: "not_found",
  "not-found": "not_found",
  enoent: "not_found",
  model_failure: "model_failure",
  "model-failure": "model_failure",
  upstream_error: "upstream_error",
  "upstream-error": "upstream_error",
  cancelled: "cancelled",
  canceled: "cancelled",
  task_cancelled: "cancelled",
  abort_err: "cancelled",
  model_request_aborted: "cancelled",
  tool_error: "tool_error",
  "tool-error": "tool_error",
  unknown: "unknown"
});

// The status that belongs to an error code. A denial and a timeout are
// terminal states of their own, everything else is a plain error.
const STATUS_BY_CODE = Object.freeze({
  invalid_args: "error",
  tool_denied: "denied",
  timeout: "timeout",
  not_found: "error",
  model_failure: "error",
  upstream_error: "error",
  cancelled: "error",
  tool_error: "error",
  unknown: "error"
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// A short, printable text. A control character means the value came from
// somewhere untrusted, so it is dropped rather than stored.
function shortText(value, maxLength) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return "";
  return trimmed.slice(0, maxLength);
}

function looksSecret(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (text.length < 8) return false;
  return SECRET_VALUE_PATTERNS.some(pattern => pattern.test(text));
}

// A text that is safe to store: no control character, no credential shape.
function safeText(value, maxLength, fallback = "") {
  const text = shortText(value, maxLength);
  if (!text) return fallback;
  if (looksSecret(text)) return REDACTED;
  return text;
}

function safeRisk(value) {
  const text = shortText(value, MAX_TEXT_LENGTH);
  if (RISKS.has(text)) return text;
  return text ? "unknown" : "unknown";
}

// The source of a tool tells where the call came from: the built-in
// catalogue, a Skill or an external MCP server.
function safeSource(value) {
  if (isPlainObject(value)) {
    const kind = shortText(value.kind, MAX_SOURCE_LENGTH);
    if (kind) return safeText(kind, MAX_SOURCE_LENGTH, "unknown");
    const id = shortText(value.id, MAX_SOURCE_LENGTH);
    return id ? safeText(id, MAX_SOURCE_LENGTH, "unknown") : "unknown";
  }
  const text = shortText(value, MAX_SOURCE_LENGTH);
  return text ? safeText(text, MAX_SOURCE_LENGTH, "unknown") : "unknown";
}

// A stable serialization, so the same arguments always produce the same
// fingerprint whatever order the keys arrived in.
function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    return "null";
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map(key => JSON.stringify(key) + ":" + canonicalize(value[key])).join(",") + "]";
}

function fingerprint(value) {
  return createHash("sha256").update(canonicalize(value ?? null), "utf8").digest("hex").slice(0, FINGERPRINT_LENGTH);
}

function byteLength(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (typeof value === "number" || typeof value === "boolean") return Buffer.byteLength(String(value), "utf8");
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

/**
 * Classifies a thrown error into the observer vocabulary.
 *
 * The base classification is the one of the trace module, so a record and a
 * trace entry never disagree about the same failure. The observer only adds
 * the codes the trace does not know yet: a model failure and a plain tool
 * failure.
 *
 * @param {unknown} error
 * @returns {{ status: string, errorCode: string }}
 */
export function classifyObserverError(error) {
  if (!error || typeof error !== "object") return { status: "error", errorCode: "unknown" };
  const code = typeof error.code === "string" ? error.code.trim() : "";
  const alias = CODE_ALIASES[code.toLowerCase()];
  if (alias) return { status: STATUS_BY_CODE[alias], errorCode: alias };
  if (MODEL_FAILURE_CODES.has(code)) return { status: "error", errorCode: "model_failure" };
  const base = classifyToolError(error);
  switch (base.errorClass) {
    case "timeout": return { status: "timeout", errorCode: "timeout" };
    case "policy-denied": return { status: "denied", errorCode: "tool_denied" };
    case "validation-error": return { status: "error", errorCode: "invalid_args" };
    case "not-found": return { status: "error", errorCode: "not_found" };
    case "cancelled": return { status: "error", errorCode: "cancelled" };
    case "upstream-error": return { status: "error", errorCode: "upstream_error" };
    default: return { status: "error", errorCode: "tool_error" };
  }
}

// A tool that answers with a failure object instead of throwing. The message
// of the failure is ignored on purpose: only its code is classified.
function classifyResult(value) {
  if (!isPlainObject(value) || value.ok !== false) return null;
  const error = isPlainObject(value.error) ? value.error : {};
  return classifyObserverError({
    code: error.code,
    statusCode: error.statusCode,
    reason: error.reason,
    name: error.name
  });
}

/**
 * Creates the observer.
 *
 * @param {object} options
 * @param {object|null} options.trace       a tool tracer (see tool-trace.mjs) or any
 *                                          object that accepts a record via record()/push()/add()
 * @param {object|null} options.logger      a structured logger (see structured-logger.mjs)
 * @param {Function}   options.clock        returns the ISO timestamp of a moment
 * @param {Function|null} options.now       returns the epoch milliseconds of a moment
 * @param {number}     options.maxRecords   how many records are kept in memory
 */
export function createToolCallObserver({
  trace = null,
  logger = null,
  clock = () => new Date().toISOString(),
  now = null,
  maxRecords = DEFAULT_MAX_RECORDS
} = {}) {
  if (trace !== null && typeof trace !== "object") throw new TypeError("trace must be an object");
  if (logger !== null && typeof logger !== "object") throw new TypeError("logger must be an object");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (now !== null && typeof now !== "function") throw new TypeError("now must be a function");
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 100_000) throw new TypeError("Invalid maxRecords");

  const records = [];
  let sequence = 0;

  // One moment of a call: the ISO text and the epoch milliseconds. When only a
  // clock is given, the milliseconds are read from the clock, so a test can
  // drive the duration with a single clock function.
  function stamp() {
    const iso = shortText(clock(), MAX_TEXT_LENGTH) || new Date().toISOString();
    if (now) return { ms: now(), iso };
    const parsed = Date.parse(iso);
    return { ms: Number.isFinite(parsed) ? parsed : Date.now(), iso };
  }

  function remember(record) {
    records.push(record);
    while (records.length > maxRecords) records.shift();
  }

  // The tracer of Phase 146 is optional. When it is present the call runs
  // through it, so the trace also gets the argument fingerprint and the
  // result size. A tracer that refuses to start never breaks the call.
  function tracedRunner(context) {
    if (!trace || typeof trace.trace !== "function") return null;
    try {
      const traced = trace.trace({
        toolId: context.toolId,
        risk: context.risk,
        sessionId: context.sessionId,
        taskId: context.taskId,
        requestId: context.requestId
      });
      if (traced && typeof traced.run === "function") return traced;
    } catch {
      // A broken tracer is not a reason to fail a tool call.
    }
    return null;
  }

  // A trace target that accepts a record directly. This is what a route or a
  // custom collector implements.
  function traceRecord(entry) {
    if (!trace || typeof trace !== "object") return;
    for (const method of ["record", "push", "add", "append"]) {
      if (typeof trace[method] === "function") {
        try {
          trace[method]({ ...entry });
        } catch {
          // A failing collector must not break the observed call.
        }
        return;
      }
    }
  }

  function logRecord(entry) {
    if (!logger || typeof logger !== "object") return;
    const fields = {
      toolId: entry.toolId,
      source: entry.source,
      risk: entry.risk,
      status: entry.status,
      errorCode: entry.errorCode,
      durationMs: entry.durationMs
    };
    const level = entry.status === "ok" ? "info" : (entry.status === "denied" ? "warn" : "error");
    try {
      if (typeof logger.log === "function") {
        logger.log(level, "tool.call", fields);
        return;
      }
      const method = typeof logger[level] === "function" ? level : "info";
      if (typeof logger[method] === "function") logger[method]("tool.call", fields);
    } catch {
      // A failing logger must not break the observed call.
    }
  }

  /**
   * Observes one tool call.
   *
   * The wrapped function is called exactly once. The returned promise settles
   * with the same value and the same error the wrapped function produced.
   *
   * @param {object} context
   * @param {string} context.toolId       the identifier of the tool
   * @param {string} [context.source]     where the tool comes from
   * @param {string} [context.risk]       read-only, write or destructive
   * @param {string} [context.sessionId]  the session the call belongs to
   * @param {string} [context.taskId]     the task the call belongs to
   * @param {string} [context.requestId]  the request the call belongs to
   * @param {unknown} [context.args]      the arguments, reduced to a fingerprint
   * @param {number} [context.timeoutMs]  an optional deadline for the call
   * @param {Function} fn                 the call to observe
   */
  async function observe(context = {}, fn) {
    if (typeof fn !== "function") throw new TypeError("fn must be a function");
    const meta = {
      toolId: safeText(context?.toolId, MAX_ID_LENGTH, "unknown"),
      source: safeSource(context?.source),
      risk: safeRisk(context?.risk),
      sessionId: safeText(context?.sessionId, MAX_TEXT_LENGTH),
      taskId: safeText(context?.taskId, MAX_TEXT_LENGTH),
      requestId: safeText(context?.requestId, MAX_TEXT_LENGTH),
      argsFingerprint: context?.args === undefined ? "" : fingerprint(context.args),
      argsBytes: context?.args === undefined ? 0 : byteLength(context.args)
    };
    const timeoutMs = Number.isInteger(context?.timeoutMs) && context.timeoutMs > 0 ? context.timeoutMs : 0;

    const started = stamp();
    let status = "ok";
    let errorCode = "";
    let result;
    let failure = null;

    const runner = tracedRunner(meta);
    const invoke = async () => {
      const work = Promise.resolve().then(() => (runner ? runner.run(meta.args, () => fn(context?.args)) : fn(context?.args)));
      if (!timeoutMs) return work;
      let timer = null;
      const guard = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error("Tool call timed out"), { code: "ETIMEDOUT", name: "TimeoutError" }));
        }, timeoutMs);
      });
      try {
        return await Promise.race([work, guard]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    try {
      result = await invoke();
      const shaped = classifyResult(result);
      if (shaped) {
        status = shaped.status;
        errorCode = shaped.errorCode;
      }
    } catch (error) {
      failure = error;
      const classified = classifyObserverError(error);
      status = classified.status;
      errorCode = classified.errorCode;
    } finally {
      const ended = stamp();
      sequence += 1;
      const record = {
        id: sequence,
        toolId: meta.toolId,
        source: meta.source,
        risk: meta.risk,
        sessionId: meta.sessionId,
        taskId: meta.taskId,
        requestId: meta.requestId,
        startedAt: started.iso,
        endedAt: ended.iso,
        durationMs: Math.max(0, ended.ms - started.ms),
        status,
        errorCode,
        argsFingerprint: meta.argsFingerprint,
        argsBytes: meta.argsBytes
      };
      remember(record);
      logRecord(record);
      traceRecord(record);
    }

    if (failure) throw failure;
    return result;
  }

  /**
   * Lists the recorded calls, oldest first.
   *
   * @param {number} [limit] how many of the most recent records to return
   * @returns {object[]}
   */
  function listRecords(limit) {
    const snapshot = records.map(record => ({ ...record }));
    if (limit === undefined || limit === null) return snapshot;
    const count = Number(limit);
    if (!Number.isFinite(count)) return snapshot;
    const size = Math.max(0, Math.floor(count));
    if (!size) return [];
    return snapshot.slice(-size);
  }

  /**
   * Removes every record from the memory. The persisted trace file is not
   * touched: the tracer of Phase 146 owns that file.
   */
  function clear() {
    records.length = 0;
  }

  /**
   * A short overview of the recorded calls.
   */
  function summary() {
    const byStatus = { ok: 0, error: 0, denied: 0, timeout: 0 };
    const bySource = {};
    const byTool = {};
    let totalDurationMs = 0;
    for (const record of records) {
      byStatus[record.status] = (byStatus[record.status] || 0) + 1;
      bySource[record.source] = (bySource[record.source] || 0) + 1;
      if (!byTool[record.toolId]) byTool[record.toolId] = { count: 0, totalDurationMs: 0 };
      byTool[record.toolId].count += 1;
      byTool[record.toolId].totalDurationMs += record.durationMs;
      totalDurationMs += record.durationMs;
    }
    return { total: records.length, maxRecords, byStatus, bySource, byTool, totalDurationMs };
  }

  return Object.freeze({
    observe,
    listRecords,
    clear,
    summary,
    count: () => records.length,
    maxRecords
  });
}

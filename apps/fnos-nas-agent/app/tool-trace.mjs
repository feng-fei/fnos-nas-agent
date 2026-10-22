import { appendFile, chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

// A tool trace answers one question: "what did the agent do, how long did it take
// and why did it fail?" It deliberately answers nothing else. The arguments of a
// call and the value it returned are never stored: a tool argument can be a file
// path, a search string or an uploaded payload, and a tool result can contain
// file content. Only sizes, timings and an irreversible fingerprint are kept.
//
// The error message is not stored either. An upstream error can carry an
// endpoint, a token or a provider detail, so only a fixed classification
// vocabulary reaches the trace.
const OUTCOMES = new Set(["success", "error", "denied", "timeout"]);
const ERROR_CLASSES = new Set([
  "validation-error", "policy-denied", "not-found", "timeout", "upstream-error", "cancelled", "unknown"
]);
const MAX_TEXT_LENGTH = 256;
const FINGERPRINT_LENGTH = 16;
const DEFAULT_MAX_BYTES = 1_048_576;

// The accepted risks mirror the tool catalogue. An unknown risk is kept as
// "unknown" instead of being dropped, so a trace never loses the fact that a
// call happened with an unexpected risk level.
const RISKS = new Set(["read-only", "write", "destructive"]);

function optionalText(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TEXT_LENGTH) return "";
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return "";
  return trimmed;
}

function safeRisk(value) {
  const text = optionalText(value);
  if (RISKS.has(text)) return text;
  return text ? "unknown" : "";
}

// A stable serialization: the same arguments must always produce the same
// fingerprint, whatever order the keys arrived in.
function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    return "null";
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map(key => JSON.stringify(key) + ":" + canonicalize(value[key])).join(",") + "}";
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

// The classification vocabulary is fixed. A raw error message, a stack trace or
// an upstream body never reaches a trace entry.
export function classifyToolError(error) {
  if (!error || typeof error !== "object") return { outcome: "error", errorClass: "unknown" };
  const code = typeof error.code === "string" ? error.code : "";
  if (code === "TASK_CANCELLED" || code === "ABORT_ERR" || code === "MODEL_REQUEST_ABORTED") {
    return { outcome: "error", errorClass: "cancelled" };
  }
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "TIMEOUT" || error.name === "TimeoutError" || error.statusCode === 504) {
    return { outcome: "timeout", errorClass: "timeout" };
  }
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : null;
  if (statusCode === 403) return { outcome: "denied", errorClass: "policy-denied" };
  if (statusCode === 401) return { outcome: "denied", errorClass: "policy-denied" };
  if (statusCode === 400 || statusCode === 422) return { outcome: "error", errorClass: "validation-error" };
  if (statusCode === 404) return { outcome: "error", errorClass: "not-found" };
  if (statusCode !== null && statusCode >= 500) return { outcome: "error", errorClass: "upstream-error" };
  const reason = typeof error.reason === "string" ? error.reason : "";
  if (reason === "missing-capability" || reason === "approval-required" || reason === "read-only-mode" || reason === "kill-switch") {
    return { outcome: "denied", errorClass: "policy-denied" };
  }
  if (code === "ENOENT" || code === "ENOTFOUND") return { outcome: "error", errorClass: "not-found" };
  if (code === "EACCES" || code === "EPERM") return { outcome: "denied", errorClass: "policy-denied" };
  return { outcome: "error", errorClass: "unknown" };
}

export function createToolTracer({
  dataDir = "",
  maxEntries = 500,
  maxBytes = DEFAULT_MAX_BYTES,
  now = () => Date.now(),
  clock = () => new Date().toISOString(),
  writeFile = null
} = {}) {
  if (typeof dataDir !== "string") throw new TypeError("dataDir must be a string");
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) throw new TypeError("Invalid maxEntries");
  if (!Number.isInteger(maxBytes) || maxBytes < 128) throw new TypeError("Invalid maxBytes");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (writeFile !== null && typeof writeFile !== "function") throw new TypeError("writeFile must be a function");

  const persist = typeof dataDir === "string" && dataDir.trim() !== "";
  const file = persist ? join(dataDir, "tool-trace.jsonl") : "";
  const rotated = persist ? file + ".1" : "";
  const entries = [];
  let queue = Promise.resolve();

  function remember(entry) {
    entries.push(entry);
    while (entries.length > maxEntries) entries.shift();
  }

  async function writeLine(line) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    try {
      const info = await stat(file);
      if (info.size + Buffer.byteLength(line) > maxBytes) {
        await rm(rotated, { force: true });
        await rename(file, rotated);
        await chmod(rotated, 0o600);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (Buffer.byteLength(line) > maxBytes) return;
    if (writeFile) {
      await writeFile(file, line);
      return;
    }
    await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
    await chmod(file, 0o600);
  }

  function persistEntry(entry) {
    if (!persist) return;
    let line;
    try {
      line = JSON.stringify(entry) + "\n";
    } catch {
      return;
    }
    // A failing trace write must never break the tool call it describes.
    queue = queue.then(() => writeLine(line)).catch(error => {
      console.error(`[tool-trace] Could not append trace entry to ${file}: ${error?.message || "unknown error"}`);
    });
  }

  function trace(context = {}) {
    const toolId = optionalText(context?.toolId);
    const risk = safeRisk(context?.risk);
    const sessionId = optionalText(context?.sessionId);
    const taskId = optionalText(context?.taskId);
    const requestId = optionalText(context?.requestId);
    return async function run(args, invokeFn) {
      if (typeof invokeFn !== "function") throw new TypeError("invokeFn must be a function");
      const startedMs = now();
      const startedAt = clock();
      const argsFingerprint = fingerprint(args);
      const argsBytes = byteLength(args);
      let outcome = "success";
      let errorClass = "";
      let resultBytes = 0;
      try {
        const result = await invokeFn(args);
        resultBytes = byteLength(result);
        return result;
      } catch (error) {
        const classified = classifyToolError(error);
        outcome = classified.outcome;
        errorClass = classified.errorClass;
        throw error;
      } finally {
        const endedMs = now();
        const endedAt = clock();
        const entry = {
          toolId,
          risk,
          sessionId,
          taskId,
          requestId,
          startedAt,
          endedAt,
          durationMs: Math.max(0, endedMs - startedMs),
          outcome: OUTCOMES.has(outcome) ? outcome : "error",
          resultBytes,
          errorClass: outcome === "success" ? "" : (ERROR_CLASSES.has(errorClass) ? errorClass : "unknown"),
          argsFingerprint,
          argsBytes
        };
        remember(entry);
        persistEntry(entry);
      }
    };
  }

  function list() {
    return entries.map(entry => ({ ...entry }));
  }

  function clear() {
    entries.length = 0;
  }

  function summary() {
    const byTool = {};
    const byOutcome = { success: 0, error: 0, denied: 0, timeout: 0 };
    let totalDurationMs = 0;
    for (const entry of entries) {
      const key = entry.toolId || "unknown";
      if (!byTool[key]) byTool[key] = { count: 0, totalDurationMs: 0, outcomes: { success: 0, error: 0, denied: 0, timeout: 0 } };
      byTool[key].count += 1;
      byTool[key].totalDurationMs += entry.durationMs;
      byTool[key].outcomes[entry.outcome] = (byTool[key].outcomes[entry.outcome] || 0) + 1;
      byOutcome[entry.outcome] = (byOutcome[entry.outcome] || 0) + 1;
      totalDurationMs += entry.durationMs;
    }
    return { total: entries.length, maxEntries, byTool, byOutcome, totalDurationMs };
  }

  return Object.freeze({
    trace,
    list,
    clear,
    summary,
    flush() { return queue; },
    filePath() { return file; }
  });
}

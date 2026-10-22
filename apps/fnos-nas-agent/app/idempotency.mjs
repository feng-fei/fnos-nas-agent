/**
 * Phase 199 — in-memory idempotency control (pure function layer).
 *
 * The store answers one question: should this request execute, replay a prior
 * result, wait for the in-flight attempt, or be refused? It never performs the
 * action itself, never persists records, and never authenticates a caller.
 */

export const IDEMPOTENCY_DECISIONS = Object.freeze({
  EXECUTE: "execute",
  REPLAY: "replay",
  IN_PROGRESS: "in-progress",
  CONFLICT: "conflict",
  REJECT: "reject"
});

export const MAX_KEY_LENGTH = 128;
export const MAX_RECORDS = 500;
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_ACTION_LENGTH = 128;
const MAX_PARAMS_DEPTH = 16;
const MAX_FINGERPRINT_PARAMS_LENGTH = 4096;
const NOTE_PARAMS_TRUNCATED = "params-truncated";

const KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

const REASON = Object.freeze({
  INVALID_KEY: "invalid-key",
  INVALID_ACTION: "invalid-action",
  INVALID_PARAMS: "invalid-params",
  UNKNOWN_KEY: "unknown-key",
  ALREADY_COMPLETED: "already-completed",
  CAPACITY: "capacity"
});

/**
 * Canonical JSON-like serialization used only for equality comparison.
 * Returns null for any value that cannot be represented losslessly:
 * functions, undefined, symbols, BigInt, non-finite numbers, sparse arrays,
 * class instances, circular references, or nesting beyond the depth bound.
 */
function stableSerialize(value, depth, stack) {
  if (depth > MAX_PARAMS_DEPTH) return null;
  if (value === null) return "null";
  const type = typeof value;
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (type === "string") return JSON.stringify(value);
  if (type !== "object") return null;
  if (stack.has(value)) return null;
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const parts = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) return null;
        const item = stableSerialize(value[index], depth + 1, stack);
        if (item === null) return null;
        parts.push(item);
      }
      return `[${parts.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
      const item = stableSerialize(value[key], depth + 1, stack);
      if (item === null) return null;
      parts.push(`${JSON.stringify(key)}:${item}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

function buildFingerprint(action, params) {
  if (typeof action !== "string" || !action.trim() || action.length > MAX_ACTION_LENGTH) return null;
  let serialized;
  try {
    serialized = stableSerialize(params, 0, new Set());
  } catch {
    return null;
  }
  if (serialized === null) return null;
  const truncated = serialized.length > MAX_FINGERPRINT_PARAMS_LENGTH;
  const bounded = truncated ? serialized.slice(0, MAX_FINGERPRINT_PARAMS_LENGTH) : serialized;
  return {
    fingerprint: `${action.length}:${action}:${bounded}`,
    truncated
  };
}

/**
 * Trims the key and accepts only `[A-Za-z0-9._:-]` with 1..128 characters.
 * Returns null for anything else; callers must not guess a replacement key.
 */
export function normalizeIdempotencyKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (key.length < 1 || key.length > MAX_KEY_LENGTH) return null;
  return KEY_PATTERN.test(key) ? key : null;
}

/**
 * Stable request fingerprint for direct assertions.
 * Returns null when the action is unusable or the params are not JSON-safe.
 * The action is length-prefixed so no separator can be forged by the params.
 */
export function fingerprintRequest(action, params) {
  const built = buildFingerprint(action, params);
  return built === null ? null : built.fingerprint;
}

const rejection = (reason) => Object.freeze({ decision: IDEMPOTENCY_DECISIONS.REJECT, reason });
const failure = (reason) => Object.freeze({ ok: false, reason });
const OK = Object.freeze({ ok: true });

/**
 * Creates a bounded, in-memory idempotency store.
 *
 * TTL is measured from the completion time, not the begin time. In-progress
 * records are never expired or evicted by this layer; the caller must settle
 * them with complete() or fail().
 */
export function createIdempotencyStore({ now, ttlMs = DEFAULT_TTL_MS, maxRecords = MAX_RECORDS } = {}) {
  if (now !== undefined && typeof now !== "function") throw new TypeError("now must be a function returning milliseconds");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError("ttlMs must be a positive safe integer");
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) throw new TypeError("maxRecords must be a positive safe integer");
  const readClock = now ?? (() => Date.now());
  const records = new Map();
  let issuedTokens = 0;

  function currentTime() {
    const value = readClock();
    if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("now() must return a finite number");
    return value;
  }

  function pruneAt(at) {
    let removed = 0;
    for (const [key, record] of records) {
      if (record.status === "completed" && at >= record.expiresAt) {
        records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  function evictCompletedLru() {
    let victimKey = null;
    let victimAccess = Infinity;
    for (const [key, record] of records) {
      if (record.status === "completed" && record.lastAccess < victimAccess) {
        victimKey = key;
        victimAccess = record.lastAccess;
      }
    }
    if (victimKey === null) return false;
    records.delete(victimKey);
    return true;
  }

  function view(record) {
    return Object.freeze({
      key: record.key,
      status: record.status,
      result: record.result,
      fingerprint: record.fingerprint,
      notes: Object.freeze(record.notes.slice()),
      createdAt: record.createdAt,
      completedAt: record.completedAt,
      expiresAt: record.expiresAt
    });
  }

  function begin({ key, action, params } = {}) {
    const normalizedKey = normalizeIdempotencyKey(key);
    if (normalizedKey === null) return rejection(REASON.INVALID_KEY);
    const built = buildFingerprint(action, params);
    if (built === null) {
      if (typeof action !== "string" || !action.trim() || action.length > MAX_ACTION_LENGTH) return rejection(REASON.INVALID_ACTION);
      return rejection(REASON.INVALID_PARAMS);
    }

    const at = currentTime();
    pruneAt(at);
    const existing = records.get(normalizedKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== built.fingerprint) return Object.freeze({ decision: IDEMPOTENCY_DECISIONS.CONFLICT });
      existing.lastAccess = at;
      if (existing.status === "completed") return Object.freeze({ decision: IDEMPOTENCY_DECISIONS.REPLAY, result: existing.result });
      return Object.freeze({ decision: IDEMPOTENCY_DECISIONS.IN_PROGRESS });
    }

    while (records.size >= maxRecords && evictCompletedLru()) { /* free completed LRU entries */ }
    if (records.size >= maxRecords) return rejection(REASON.CAPACITY);

    issuedTokens += 1;
    const token = `t${issuedTokens}`;
    records.set(normalizedKey, {
      key: normalizedKey,
      fingerprint: built.fingerprint,
      status: "in-progress",
      result: undefined,
      notes: built.truncated ? [NOTE_PARAMS_TRUNCATED] : [],
      createdAt: at,
      completedAt: null,
      expiresAt: null,
      lastAccess: at
    });
    return Object.freeze({ decision: IDEMPOTENCY_DECISIONS.EXECUTE, token });
  }

  function complete({ key, result } = {}) {
    const normalizedKey = normalizeIdempotencyKey(key);
    if (normalizedKey === null) return failure(REASON.INVALID_KEY);
    const at = currentTime();
    pruneAt(at);
    const record = records.get(normalizedKey);
    if (record === undefined) return failure(REASON.UNKNOWN_KEY);
    if (record.status === "completed") return failure(REASON.ALREADY_COMPLETED);
    record.status = "completed";
    record.result = result;
    record.completedAt = at;
    record.expiresAt = at + ttlMs;
    record.lastAccess = at;
    return OK;
  }

  function fail({ key } = {}) {
    const normalizedKey = normalizeIdempotencyKey(key);
    if (normalizedKey === null) return failure(REASON.INVALID_KEY);
    const at = currentTime();
    pruneAt(at);
    const record = records.get(normalizedKey);
    if (record === undefined) return failure(REASON.UNKNOWN_KEY);
    if (record.status === "completed") return failure(REASON.ALREADY_COMPLETED);
    records.delete(normalizedKey);
    return OK;
  }

  function lookup(key) {
    const normalizedKey = normalizeIdempotencyKey(key);
    if (normalizedKey === null) return null;
    const at = currentTime();
    pruneAt(at);
    const record = records.get(normalizedKey);
    if (record === undefined) return null;
    record.lastAccess = at;
    return view(record);
  }

  function prune() {
    return pruneAt(currentTime());
  }

  function size() {
    pruneAt(currentTime());
    return records.size;
  }

  return Object.freeze({ begin, complete, fail, lookup, prune, size });
}

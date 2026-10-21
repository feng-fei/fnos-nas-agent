import { createHash, randomBytes } from "node:crypto";

const RISK_LEVELS = new Set(["write", "destructive"]);
const DEFAULT_TTL_MS = 60_000;
const MAX_TTL_MS = 5 * 60_000;
const MAX_PENDING = 100;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value, depth = 0) {
  if (depth > 5) throw new TypeError("Approval arguments are too deeply nested");
  if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === "string") {
    if (value.length > 2000) throw new TypeError("Approval argument string is too long");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 50) throw new TypeError("Too many approval arguments");
    return "[" + value.map(item => canonical(item, depth + 1)).join(",") + "]";
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError("Approval arguments must be plain JSON data");
  const keys = Object.keys(value).sort();
  if (keys.length > 50) throw new TypeError("Too many approval argument fields");
  return "{" + keys.map(key => JSON.stringify(key) + ":" + canonical(value[key], depth + 1)).join(",") + "}";
}

function validateAction({ taskId, toolId, args, risk }) {
  if (typeof taskId !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(taskId)) throw new TypeError("Invalid task identifier");
  if (typeof toolId !== "string" || !/^[a-z][a-z0-9.-]{0,63}$/.test(toolId)) throw new TypeError("Invalid tool identifier");
  if (!RISK_LEVELS.has(risk)) throw new TypeError("Only write or destructive actions can receive approvals");
  return digest(canonical({ toolId, args: args ?? {} }));
}

/**
 * In-memory, one-time approval grants bound to one task, tool, argument digest and risk.
 * This ledger does not execute actions, authenticate callers, or persist grants across restarts.
 */
export function createApprovalLedger({ now = () => Date.now(), ttlMs = DEFAULT_TTL_MS, maxPending = MAX_PENDING, token = () => randomBytes(32).toString("base64url") } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TTL_MS) throw new TypeError("Approval TTL must be 1s to 5m");
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > MAX_PENDING) throw new TypeError("Invalid pending approval limit");
  const pending = new Map();

  function prune() {
    const time = now();
    for (const [key, item] of pending) if (item.expiresAt <= time) pending.delete(key);
  }

  function issue(action) {
    prune();
    const actionHash = validateAction(action);
    if (pending.size >= maxPending) throw Object.assign(new Error("Pending approval limit reached"), { statusCode: 429 });
    const secret = token();
    if (typeof secret !== "string" || secret.length < 32) throw new TypeError("Approval token source returned an invalid token");
    const tokenHash = digest(secret);
    if (pending.has(tokenHash)) throw new Error("Approval token collision");
    const issuedAt = now();
    pending.set(tokenHash, {
      taskId: action.taskId, toolId: action.toolId, risk: action.risk, actionHash,
      issuedAt, expiresAt: issuedAt + ttlMs
    });
    return Object.freeze({ token: secret, taskId: action.taskId, toolId: action.toolId, risk: action.risk, issuedAt, expiresAt: issuedAt + ttlMs });
  }

  function consume({ token: secret, taskId, toolId, args, risk } = {}) {
    prune();
    if (typeof secret !== "string" || secret.length < 32) return Object.freeze({ approved: false, reason: "invalid-token" });
    const key = digest(secret);
    const grant = pending.get(key);
    if (!grant) return Object.freeze({ approved: false, reason: "missing-expired-or-consumed" });
    let actionHash;
    try { actionHash = validateAction({ taskId, toolId, args, risk }); }
    catch { return Object.freeze({ approved: false, reason: "action-mismatch" }); }
    if (grant.taskId !== taskId || grant.toolId !== toolId || grant.risk !== risk || grant.actionHash !== actionHash)
      return Object.freeze({ approved: false, reason: "action-mismatch" });
    pending.delete(key);
    return Object.freeze({ approved: true, reason: "approved-once", taskId, toolId, risk, issuedAt: grant.issuedAt, consumedAt: now() });
  }

  function revokeTask(taskId) {
    let removed = 0;
    for (const [key, grant] of pending) if (grant.taskId === taskId) { pending.delete(key); removed++; }
    return removed;
  }

  return Object.freeze({
    issue, consume, revokeTask,
    snapshot() { prune(); return Object.freeze({ pending: pending.size, executionEnabled: false }); }
  });
}

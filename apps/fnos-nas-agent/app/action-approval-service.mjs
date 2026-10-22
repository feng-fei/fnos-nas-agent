import { randomUUID } from "node:crypto";
import { createApprovalLedger } from "./approval-ledger.mjs";
import { DELETE_CAPABILITY } from "./execution-capability.mjs";

function validateArgs(args, schema = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const properties = schema.properties || {};
  if (schema.additionalProperties === false && Object.keys(args).some(key => !Object.hasOwn(properties, key))) return false;
  for (const key of schema.required || []) if (!Object.hasOwn(args, key)) return false;
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key];
    if (!rule) return false;
    if (rule.type === "string" && (typeof value !== "string" || value.length < (rule.minLength || 0) || value.length > (rule.maxLength || Infinity))) return false;
    if (rule.type === "integer" && (!Number.isInteger(value) || value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity))) return false;
  }
  return true;
}

/**
 * In-memory confirmation queue for server-classified destructive registered tools.
 * The client never supplies the risk level or approval token.
 */
export function createActionApprovalService({ tools, ledger = createApprovalLedger(), now = () => Date.now(), id = randomUUID } = {}) {
  if (!tools || typeof tools.list !== "function" || typeof tools.invoke !== "function") throw new TypeError("A registered tool catalogue is required");
  const pending = new Map();

  function revokeTaskPending(taskId) {
    ledger.revokeTask(taskId);
    for (const [key, item] of pending) {
      if (item.taskId === taskId) pending.delete(key);
    }
  }

  function prune() {
    const time = now();
    const expiredTasks = new Set();
    for (const item of pending.values()) {
      if (item.expiresAt <= time) expiredTasks.add(item.taskId);
    }
    // Approval grants are revoked by task in the ledger. Remove every queue entry for
    // that task as well, so the UI cannot display approvals that can no longer succeed.
    for (const taskId of expiredTasks) revokeTaskPending(taskId);
  }

  function request({ toolId, args = {}, taskId = id(), sessionId = "" } = {}) {
    prune();
    const tool = tools.list().find(item => item.id === toolId);
    if (!tool) throw Object.assign(new Error("Unknown tool"), { statusCode: 404 });
    if (tool.risk !== "destructive") throw Object.assign(new Error("Only destructive registered tools use this confirmation queue"), { statusCode: 400 });
    if (!validateArgs(args, tool.inputSchema)) throw Object.assign(new Error("Invalid tool arguments"), { statusCode: 400 });
    if (pending.size >= 50) throw Object.assign(new Error("Pending action limit reached"), { statusCode: 429 });
    const grant = ledger.issue({ taskId, toolId, args, risk: tool.risk });
    const item = {
      id: id(), taskId, sessionId: typeof sessionId === "string" ? sessionId : "", toolId,
      title: tool.title, description: tool.description,
      risk: tool.risk, args: structuredClone(args), target: typeof args.path === "string" ? args.path : null,
      createdAt: grant.issuedAt, expiresAt: grant.expiresAt, token: grant.token
    };
    pending.set(item.id, item);
    return publicItem(item);
  }

  function publicItem(item) {
    return Object.freeze({
      id: item.id, taskId: item.taskId, sessionId: item.sessionId || "", toolId: item.toolId, title: item.title,
      description: item.description, risk: item.risk, args: structuredClone(item.args),
      target: item.target, createdAt: item.createdAt, expiresAt: item.expiresAt
    });
  }

  function list(sessionId = "") {
    prune();
    const scope = typeof sessionId === "string" ? sessionId : "";
    return [...pending.values()]
      .filter(item => !scope || item.sessionId === scope)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(publicItem);
  }

  async function confirm(idValue, sessionId = "") {
    prune();
    const item = pending.get(idValue);
    if (!item) throw Object.assign(new Error("Pending action not found, expired, or already handled"), { statusCode: 404 });
    const scope = typeof sessionId === "string" ? sessionId : "";
    // Ownership check happens before the grant is consumed, so a foreign session can
    // neither execute nor burn the approval token.
    if (item.sessionId && item.sessionId !== scope)
      throw Object.assign(new Error("The pending action belongs to another session"), { statusCode: 403 });
    const consumed = ledger.consume({ token: item.token, taskId: item.taskId, toolId: item.toolId, args: item.args, risk: item.risk });
    // The queue entry only disappears once the grant was actually accepted, so a
    // rejected confirmation never hides a still pending action.
    if (!consumed.approved) throw Object.assign(new Error("Confirmation is invalid or expired"), { statusCode: 409 });
    pending.delete(idValue);
    const result = await tools.invoke(item.toolId, item.args, { capability: DELETE_CAPABILITY });
    return { action: publicItem(item), result };
  }

  function revoke(idValue, sessionId = "") {
    prune();
    const item = pending.get(idValue);
    if (!item) return null;
    const scope = typeof sessionId === "string" ? sessionId : "";
    if (item.sessionId && scope && item.sessionId !== scope) return null;
    revokeTaskPending(item.taskId);
    return publicItem(item);
  }

  function deny(idValue, sessionId = "") {
    return Boolean(revoke(idValue, sessionId));
  }

  return Object.freeze({
    request, list, confirm, deny, revoke,
    revokeTask(taskId) { if (typeof taskId === "string" && taskId) revokeTaskPending(taskId); },
    snapshot: () => ({ pending: list().length })
  });
}

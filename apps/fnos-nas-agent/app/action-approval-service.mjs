import { randomUUID } from "node:crypto";
import { createApprovalLedger } from "./approval-ledger.mjs";

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

  function prune() {
    const time = now();
    for (const [key, item] of pending) {
      if (item.expiresAt <= time) {
        ledger.revokeTask(item.taskId);
        pending.delete(key);
      }
    }
  }

  function request({ toolId, args = {}, taskId = id() } = {}) {
    prune();
    const tool = tools.list().find(item => item.id === toolId);
    if (!tool) throw Object.assign(new Error("Unknown tool"), { statusCode: 404 });
    if (tool.risk !== "destructive") throw Object.assign(new Error("Only destructive registered tools use this confirmation queue"), { statusCode: 400 });
    if (!validateArgs(args, tool.inputSchema)) throw Object.assign(new Error("Invalid tool arguments"), { statusCode: 400 });
    if (pending.size >= 50) throw Object.assign(new Error("Pending action limit reached"), { statusCode: 429 });
    const grant = ledger.issue({ taskId, toolId, args, risk: tool.risk });
    const item = {
      id: id(), taskId, toolId, title: tool.title, description: tool.description,
      risk: tool.risk, args: structuredClone(args), target: typeof args.path === "string" ? args.path : null,
      createdAt: grant.issuedAt, expiresAt: grant.expiresAt, token: grant.token
    };
    pending.set(item.id, item);
    return publicItem(item);
  }

  function publicItem(item) {
    return Object.freeze({
      id: item.id, taskId: item.taskId, toolId: item.toolId, title: item.title,
      description: item.description, risk: item.risk, args: structuredClone(item.args),
      target: item.target, createdAt: item.createdAt, expiresAt: item.expiresAt
    });
  }

  function list() {
    prune();
    return [...pending.values()].sort((a, b) => a.createdAt - b.createdAt).map(publicItem);
  }

  async function confirm(idValue) {
    prune();
    const item = pending.get(idValue);
    if (!item) throw Object.assign(new Error("Pending action not found, expired, or already handled"), { statusCode: 404 });
    const consumed = ledger.consume({ token: item.token, taskId: item.taskId, toolId: item.toolId, args: item.args, risk: item.risk });
    pending.delete(idValue);
    if (!consumed.approved) throw Object.assign(new Error("Confirmation is invalid or expired"), { statusCode: 409 });
    const result = await tools.invoke(item.toolId, item.args);
    return { action: publicItem(item), result };
  }

  function deny(idValue) {
    prune();
    const item = pending.get(idValue);
    if (!item) return false;
    pending.delete(idValue);
    ledger.revokeTask(item.taskId);
    return true;
  }

  return Object.freeze({ request, list, confirm, deny, snapshot: () => ({ pending: list().length }) });
}

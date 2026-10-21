import test from "node:test";
import assert from "node:assert/strict";
import { createActionApprovalService } from "../apps/fnos-nas-agent/app/action-approval-service.mjs";
import { createApprovalLedger } from "../apps/fnos-nas-agent/app/approval-ledger.mjs";
import { createAgentCore } from "../apps/fnos-nas-agent/app/agent-core.mjs";

const deleteTool = {
  id: "files.delete", title: "删除文件或空文件夹",
  description: "删除指定文件，需要二次确认。",
  risk: "destructive",
  inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 2048 } }, required: ["path"], additionalProperties: false }
};
function tools() {
  const calls = [];
  return {
    calls,
    list: () => [deleteTool],
    invoke: async (id, args) => { calls.push({ id, args }); return { deleted: true, path: args.path }; }
  };
}

test("destructive action request only queues a concrete target and does not execute", async () => {
  const registry = tools();
  const approvals = createActionApprovalService({ tools: registry });
  const pending = approvals.request({ toolId: "files.delete", args: { path: "/vol1/archive.txt" } });
  assert.equal(pending.risk, "destructive");
  assert.equal(pending.target, "/vol1/archive.txt");
  assert.equal("token" in pending, false);
  assert.equal(registry.calls.length, 0);
  assert.equal(approvals.list().length, 1);
});

test("explicit confirmation executes the exact queued action once", async () => {
  const registry = tools();
  const approvals = createActionApprovalService({ tools: registry });
  const pending = approvals.request({ toolId: "files.delete", args: { path: "/vol1/archive.txt" } });
  const result = await approvals.confirm(pending.id);
  assert.deepEqual(result.result, { deleted: true, path: "/vol1/archive.txt" });
  assert.equal(registry.calls.length, 1);
  assert.deepEqual(registry.calls[0], { id: "files.delete", args: { path: "/vol1/archive.txt" } });
  await assert.rejects(approvals.confirm(pending.id), error => error.statusCode === 404);
  assert.equal(registry.calls.length, 1);
});

test("denied and expired actions never execute", async () => {
  let time = 1000;
  const registry = tools();
  const ledger = createApprovalLedger({ now: () => time, ttlMs: 1000 });
  const approvals = createActionApprovalService({ tools: registry, ledger, now: () => time });
  const denied = approvals.request({ toolId: "files.delete", args: { path: "/vol1/deny.txt" } });
  assert.equal(approvals.deny(denied.id), true);
  assert.equal(approvals.deny(denied.id), false);
  const expired = approvals.request({ toolId: "files.delete", args: { path: "/vol1/expire.txt" } });
  time += 1001;
  assert.equal(approvals.list().length, 0);
  await assert.rejects(approvals.confirm(expired.id), error => error.statusCode === 404);
  assert.equal(registry.calls.length, 0);
});

test("confirmation queue accepts only registered destructive tools and schema-valid arguments", () => {
  const registry = tools();
  const approvals = createActionApprovalService({ tools: registry });
  assert.throws(() => approvals.request({ toolId: "shell.exec", args: { command: "rm -rf /" } }), error => error.statusCode === 404);
  assert.throws(() => approvals.request({ toolId: "files.delete", args: { path: "/vol1/x", approved: true } }), error => error.statusCode === 400);
});

test("Agent routes delete intent to pending approval without invoking the destructive tool", async () => {
  const registry = tools();
  const pendingRequests = [];
  const agent = createAgentCore({
    tools: registry,
    model: { status: () => ({ enabled: false }), plan: async () => null },
    requestApproval: async request => { pendingRequests.push(request); return { id: "pending-action-1", target: request.args.path, risk: "destructive" }; }
  });
  const result = await agent.run({ text: "删除 /vol1/old-backup.zip" });
  assert.equal(result.status, "awaiting-approval");
  assert.equal(result.pendingApproval.target, "/vol1/old-backup.zip");
  assert.deepEqual(pendingRequests, [{ toolId: "files.delete", args: { path: "/vol1/old-backup.zip" }, taskId: result.taskId }]);
  assert.equal(registry.calls.length, 0);
});


test("unknown risk classifications fail closed before any tool invocation", async () => {
  const calls = [];
  const registry = {
    list: () => [{ id: "mystery.action", risk: "unknown", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    invoke: async (...args) => { calls.push(args); return {}; }
  };
  const agent = createAgentCore({
    tools: registry,
    model: { status: () => ({ enabled: true }), plan: async () => ({ message: "run", toolCalls: [{ id: "mystery.action", args: {} }] }) }
  });
  const result = await agent.run({ text: "执行未知操作" });
  assert.equal(result.status, "failed");
  assert.equal(calls.length, 0);
});

test("mixed plans containing a destructive action are rejected before routine writes run", async () => {
  const calls = [];
  const renameTool = { id: "files.rename", risk: "write", inputSchema: { type: "object", properties: { path: { type: "string" }, name: { type: "string" } }, required: ["path", "name"], additionalProperties: false } };
  const registry = {
    list: () => [renameTool, deleteTool],
    invoke: async (...args) => { calls.push(args); return {}; }
  };
  let requested = false;
  const agent = createAgentCore({
    tools: registry,
    model: { status: () => ({ enabled: true }), plan: async () => ({ message: "rename then delete", toolCalls: [{ id: "files.rename", args: { path: "/vol1/a", name: "b" } }, { id: "files.delete", args: { path: "/vol1/c" } }] }) },
    requestApproval: async () => { requested = true; return {}; }
  });
  const result = await agent.run({ text: "重命名后删除" });
  assert.equal(result.status, "failed");
  assert.equal(requested, false);
  assert.equal(calls.length, 0);
});

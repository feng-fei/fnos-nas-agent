import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createTaskManager } from "../apps/fnos-nas-agent/app/task-manager.mjs";
import { createActionApprovalService } from "../apps/fnos-nas-agent/app/action-approval-service.mjs";
import { createApprovalLedger } from "../apps/fnos-nas-agent/app/approval-ledger.mjs";
import { createAgentCore } from "../apps/fnos-nas-agent/app/agent-core.mjs";

const deleteTool = {
  id: "files.delete",
  title: "Delete file",
  description: "Delete one file after an explicit confirmation",
  risk: "destructive",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", minLength: 1, maxLength: 2048 } },
    required: ["path"],
    additionalProperties: false
  }
};

const readTool = {
  id: "files.list",
  title: "List files",
  description: "List files",
  risk: "read-only",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }
};

/**
 * Every case owns a private temporary directory. The directory is only used as a
 * place for the optional task-history snapshot; no assertion depends on POSIX
 * permission bits or on directory descriptors, so the suite behaves the same on
 * Windows and on Linux.
 *
 * The scope flushes every task manager it created before the directory is
 * removed, so a pending snapshot write can never race with the cleanup.
 */
async function createScope(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const managers = [];
  t.after(async () => {
    for (const manager of managers) {
      try { await manager.flush(); }
      catch { /* a failed snapshot must not fail the cleanup */ }
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });
  return { dir, managers };
}

function createManager(scope, { execute, ...options } = {}) {
  const manager = createTaskManager({
    execute: execute || (async () => ({ status: "completed", message: "done" })),
    ...options
  });
  scope.managers.push(manager);
  return manager;
}

async function waitFor(predicate, { timeout = 5000, interval = 10, message = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

function fakeTools({ invoke } = {}) {
  const calls = [];
  return {
    calls,
    list: () => [deleteTool, readTool],
    invoke: async (toolId, args, options) => {
      calls.push({ toolId, args, options });
      if (invoke) return invoke(toolId, args, options);
      return { deleted: true };
    }
  };
}

test("a task waiting for approval is not terminal and survives terminal history cleanup", async t => {
  const scope = await createScope(t, "fnos-phase137-nonterminal-");
  const manager = createManager(scope, {
    storageFile: join(scope.dir, "tasks.json"),
    execute: async () => ({ status: "awaiting-approval", message: "等待确认" })
  });

  const task = manager.submit({ text: "删除 /volume/a.txt" }, { sessionId: "session-a" });
  const waiting = await waitFor(() => {
    const current = manager.get(task.taskId, "session-a");
    return current && current.status === "awaiting-approval" ? current : null;
  }, { message: "the task to reach awaiting-approval" });

  assert.equal(waiting.status, "awaiting-approval");
  assert.equal(waiting.completedAt, null);
  assert.equal(waiting.stage, "等待确认");
  assert.ok(waiting.progress <= 99, "a waiting task must not report finished progress");

  // A non-terminal task is not part of the terminal history: clearing the history
  // removes nothing and keeps the waiting task visible.
  const cleared = await manager.clearTerminal("session-a");
  assert.equal(cleared.removed, 0);
  assert.equal(cleared.retained, 1);
  assert.equal(manager.stats().retained, 1);
  assert.equal(manager.get(task.taskId, "session-a").status, "awaiting-approval");
  assert.equal(manager.list({ status: "awaiting-approval" }).length, 1);
});

test("resolveApproval completes a waiting task and stamps the completion time", async t => {
  const scope = await createScope(t, "fnos-phase137-resolve-completed-");
  const manager = createManager(scope, {
    storageFile: join(scope.dir, "tasks.json"),
    execute: async () => ({ status: "awaiting-approval" })
  });

  const task = manager.submit({ text: "删除 /volume/a.txt" }, { sessionId: "session-a" });
  await waitFor(() => manager.get(task.taskId, "session-a")?.status === "awaiting-approval", { message: "awaiting-approval" });

  const outcome = manager.resolveApproval(task.taskId, { status: "completed", result: { deleted: true } });
  assert.equal(outcome.updated, true);
  assert.equal(outcome.task.status, "completed");
  assert.equal(outcome.task.progress, 100);
  assert.equal(outcome.task.stage, "已完成");
  assert.ok(outcome.task.completedAt, "a completed task must carry a completion timestamp");
  assert.deepEqual(outcome.task.result, { deleted: true });

  const stored = manager.get(task.taskId, "session-a");
  assert.equal(stored.status, "completed");
  assert.ok(stored.completedAt);
});

test("resolveApproval is idempotent once the task already reached a terminal state", async t => {
  const scope = await createScope(t, "fnos-phase137-resolve-idempotent-");
  const manager = createManager(scope, {
    storageFile: join(scope.dir, "tasks.json"),
    execute: async () => ({ status: "awaiting-approval" })
  });

  const task = manager.submit({ text: "删除 /volume/a.txt" }, { sessionId: "session-a" });
  await waitFor(() => manager.get(task.taskId, "session-a")?.status === "awaiting-approval", { message: "awaiting-approval" });

  const first = manager.resolveApproval(task.taskId, { status: "completed", result: { deleted: true } });
  assert.equal(first.updated, true);
  const completedAt = first.task.completedAt;

  const second = manager.resolveApproval(task.taskId, { status: "completed", result: { deleted: true } });
  assert.equal(second.updated, false);
  assert.equal(second.task.status, "completed");
  assert.equal(second.task.completedAt, completedAt, "a repeated approval must not move the completion time");
  assert.equal(manager.get(task.taskId, "session-a").status, "completed");
});

test("resolveApproval ignores an unknown task identifier without throwing", async t => {
  const scope = await createScope(t, "fnos-phase137-resolve-unknown-");
  const manager = createManager(scope, { storageFile: join(scope.dir, "tasks.json") });

  let outcome;
  assert.doesNotThrow(() => {
    outcome = manager.resolveApproval("00000000-0000-4000-8000-000000000000", { status: "completed" });
  });
  // The current implementation reports "no update" for an unknown identifier
  // (null today, { updated: false } once the shape is unified). Both mean the
  // same thing: nothing was updated and nothing threw.
  assert.ok(outcome === null || outcome.updated === false, "an unknown task must not be reported as updated");
  assert.equal(manager.stats().retained, 0);
});

test("resolveApproval does not change a task that already reached completed or failed", async t => {
  const scope = await createScope(t, "fnos-phase137-resolve-terminal-");
  const manager = createManager(scope, {
    storageFile: join(scope.dir, "tasks.json"),
    execute: async () => ({ status: "completed", message: "ok" })
  });

  const completed = manager.submit({ text: "list" }, { sessionId: "session-a" });
  await waitFor(() => manager.get(completed.taskId, "session-a")?.status === "completed", { message: "completed" });
  const completedBefore = manager.get(completed.taskId, "session-a");

  const completedOutcome = manager.resolveApproval(completed.taskId, { status: "cancelled" });
  assert.equal(completedOutcome.updated, false);
  assert.equal(completedOutcome.task.status, "completed");
  assert.equal(completedOutcome.task.completedAt, completedBefore.completedAt);

  const failing = createManager(scope, {
    storageFile: join(scope.dir, "tasks-failed.json"),
    execute: async () => ({ status: "failed", message: "boom" })
  });
  const failed = failing.submit({ text: "boom" }, { sessionId: "session-a" });
  await waitFor(() => failing.get(failed.taskId, "session-a")?.status === "failed", { message: "failed" });
  const failedBefore = failing.get(failed.taskId, "session-a");

  const failedOutcome = failing.resolveApproval(failed.taskId, { status: "completed" });
  assert.equal(failedOutcome.updated, false);
  assert.equal(failedOutcome.task.status, "failed");
  assert.equal(failedOutcome.task.completedAt, failedBefore.completedAt);
});

test("an execute result of failed marks the task failed instead of completed", async t => {
  const scope = await createScope(t, "fnos-phase137-execute-failed-");
  const manager = createManager(scope, {
    storageFile: join(scope.dir, "tasks.json"),
    execute: async () => ({ status: "failed", message: "tool refused" })
  });

  const task = manager.submit({ text: "boom" }, { sessionId: "session-a" });
  const failed = await waitFor(() => {
    const current = manager.get(task.taskId, "session-a");
    return current && current.status === "failed" ? current : null;
  }, { message: "the task to fail" });

  assert.notEqual(failed.status, "completed");
  assert.equal(failed.status, "failed");
  assert.equal(failed.stage, "执行失败");
  assert.equal(failed.error, "tool refused");
  assert.ok(failed.completedAt, "a failed task is terminal and carries a completion timestamp");
});

test("an execute result of awaiting-approval keeps the task waiting instead of completed", async t => {
  const scope = await createScope(t, "fnos-phase137-execute-awaiting-");
  const manager = createManager(scope, {
    storageFile: join(scope.dir, "tasks.json"),
    execute: async () => ({ status: "awaiting-approval", message: "需要确认" })
  });

  const task = manager.submit({ text: "删除 /volume/a.txt" }, { sessionId: "session-a" });
  const waiting = await waitFor(() => {
    const current = manager.get(task.taskId, "session-a");
    return current && current.status === "awaiting-approval" ? current : null;
  }, { message: "the task to wait for approval" });

  assert.notEqual(waiting.status, "completed");
  assert.equal(waiting.status, "awaiting-approval");
  assert.equal(waiting.completedAt, null);
  assert.equal(waiting.error, null);
});

test("a task submitted by one session stays invisible to another session", async t => {
  const scope = await createScope(t, "fnos-phase137-session-isolation-");
  const manager = createManager(scope, {
    storageFile: join(scope.dir, "tasks.json"),
    execute: async () => ({ status: "completed", message: "ok" })
  });

  const task = manager.submit({ text: "list" }, { sessionId: "session-a" });
  await waitFor(() => manager.get(task.taskId, "session-a")?.status === "completed", { message: "completed" });

  // The owning session sees the task.
  assert.equal(manager.get(task.taskId, "session-a").taskId, task.taskId);
  assert.equal(manager.list({ sessionId: "session-a" }).length, 1);
  assert.equal(manager.query({ sessionId: "session-a" }).total, 1);

  // Another session sees nothing and cannot cancel or clear the task.
  assert.equal(manager.get(task.taskId, "session-b"), null);
  assert.deepEqual(manager.list({ sessionId: "session-b" }), []);
  assert.equal(manager.query({ sessionId: "session-b" }).total, 0);
  assert.deepEqual(manager.query({ sessionId: "session-b" }).tasks, []);
  assert.equal(manager.cancel(task.taskId, "session-b"), null);

  const cleared = await manager.clearTerminal("session-b");
  assert.equal(cleared.removed, 0);
  assert.equal(cleared.retained, 1);
  assert.equal(manager.get(task.taskId, "session-a").status, "completed");
});

test("cancelling a task that waits for approval moves it to cancelled", async t => {
  const scope = await createScope(t, "fnos-phase137-cancel-awaiting-");
  const manager = createManager(scope, {
    storageFile: join(scope.dir, "tasks.json"),
    execute: async () => ({ status: "awaiting-approval" })
  });

  const task = manager.submit({ text: "删除 /volume/a.txt" }, { sessionId: "session-a" });
  await waitFor(() => manager.get(task.taskId, "session-a")?.status === "awaiting-approval", { message: "awaiting-approval" });

  const result = manager.cancel(task.taskId, "session-a");
  assert.equal(result.cancelled, true);
  assert.equal(result.task.status, "cancelled");
  assert.ok(result.task.error.includes("取消"), "the cancellation reason must be reported to the operator");
  assert.ok(result.task.completedAt);
  assert.equal(manager.get(task.taskId, "session-a").status, "cancelled");
});

test("confirming an approval from another session is rejected and keeps the pending item", async t => {
  const tools = fakeTools();
  const ledger = createApprovalLedger();
  const service = createActionApprovalService({ tools, ledger });

  const pending = service.request({
    toolId: deleteTool.id,
    args: { path: "/volume/a.txt" },
    taskId: "task_12345678",
    sessionId: "session-a"
  });

  await assert.rejects(
    service.confirm(pending.id, "session-b"),
    { statusCode: 403, message: "The pending action belongs to another session" }
  );

  // The rejected confirmation neither executed the tool nor consumed the grant.
  assert.equal(tools.calls.length, 0);
  assert.equal(ledger.snapshot().pending, 1);
  assert.deepEqual(service.list("session-a").map(item => item.id), [pending.id]);
  assert.deepEqual(service.list("session-b"), []);
});

test("a rejected approval grant keeps the pending item in the queue", async t => {
  const tools = fakeTools();
  const real = createApprovalLedger();
  // The grant is issued by the real ledger but the consumption is refused, which
  // is what an expired or tampered grant looks like to the service.
  const ledger = {
    issue: action => real.issue(action),
    consume: () => Object.freeze({ approved: false, reason: "forced-mismatch" }),
    revokeTask: taskId => real.revokeTask(taskId),
    snapshot: () => real.snapshot()
  };
  const service = createActionApprovalService({ tools, ledger });

  const pending = service.request({
    toolId: deleteTool.id,
    args: { path: "/volume/a.txt" },
    taskId: "task_12345678",
    sessionId: "session-a"
  });

  await assert.rejects(service.confirm(pending.id, "session-a"), { statusCode: 409 });
  assert.equal(tools.calls.length, 0, "a refused grant must not execute the destructive tool");
  assert.deepEqual(service.list("session-a").map(item => item.id), [pending.id], "the pending item must stay visible");
  assert.equal(service.snapshot().pending, 1);
});

test("deny reports a boolean result and returns false for an unknown identifier", async t => {
  const tools = fakeTools();
  const ledger = createApprovalLedger();
  const service = createActionApprovalService({ tools, ledger });

  const pending = service.request({
    toolId: deleteTool.id,
    args: { path: "/volume/a.txt" },
    taskId: "task_12345678",
    sessionId: "session-a"
  });

  assert.equal(service.deny(pending.id, "session-a"), true);
  assert.equal(service.deny(pending.id, "session-a"), false, "a denied action cannot be denied twice");
  assert.equal(service.deny("00000000-0000-4000-8000-000000000000", "session-a"), false);
  assert.equal(service.deny("00000000-0000-4000-8000-000000000000"), false);
  assert.equal(service.snapshot().pending, 0);
  assert.equal(ledger.snapshot().pending, 0);
  assert.equal(tools.calls.length, 0);
});

test("revoke removes the pending item and returns null for an unknown identifier", async t => {
  const tools = fakeTools();
  const ledger = createApprovalLedger();
  const service = createActionApprovalService({ tools, ledger });

  const pending = service.request({
    toolId: deleteTool.id,
    args: { path: "/volume/a.txt" },
    taskId: "task_12345678",
    sessionId: "session-a"
  });

  const revoked = service.revoke(pending.id, "session-a");
  assert.ok(revoked);
  assert.equal(revoked.id, pending.id);
  assert.equal(revoked.taskId, "task_12345678");
  assert.equal(service.snapshot().pending, 0);
  assert.equal(service.revoke(pending.id, "session-a"), null);
  assert.equal(service.revoke("00000000-0000-4000-8000-000000000000", "session-a"), null);
  assert.equal(tools.calls.length, 0);
});

test("a confirmed approval advances the linked task from awaiting-approval to completed", async t => {
  const scope = await createScope(t, "fnos-phase137-approval-task-link-");
  const tools = fakeTools();
  const ledger = createApprovalLedger();
  const service = createActionApprovalService({ tools, ledger });

  let pending = null;
  const manager = createManager(scope, {
    storageFile: join(scope.dir, "tasks.json"),
    execute: async (input, context) => {
      // The queue task id is reused for the approval item, exactly like the
      // agent core does with context.taskId.
      pending = service.request({
        toolId: deleteTool.id,
        args: { path: "/volume/a.txt" },
        taskId: context.taskId,
        sessionId: context.sessionId
      });
      return { status: "awaiting-approval", pendingApproval: pending };
    }
  });

  const task = manager.submit({ text: "删除 /volume/a.txt" }, { sessionId: "session-a" });
  await waitFor(() => manager.get(task.taskId, "session-a")?.status === "awaiting-approval", { message: "awaiting-approval" });

  assert.ok(pending, "the executor must have requested an approval");
  assert.equal(pending.taskId, task.taskId, "the approval item reuses the queue task id");

  // The server couples a successful confirmation with the task resolution.
  const confirmed = await service.confirm(pending.id, "session-a");
  assert.deepEqual(confirmed.result, { deleted: true });
  assert.equal(tools.calls.length, 1);
  assert.equal(tools.calls[0].toolId, deleteTool.id);
  assert.deepEqual(tools.calls[0].args, { path: "/volume/a.txt" });

  const resolved = manager.resolveApproval(confirmed.action.taskId, { status: "completed", result: confirmed.result });
  assert.equal(resolved.updated, true);
  assert.equal(resolved.task.status, "completed");
  assert.ok(resolved.task.completedAt);
  assert.equal(manager.get(task.taskId, "session-a").status, "completed");
  assert.equal(service.snapshot().pending, 0);
});

test("the agent core reuses the queue task id for the approval item and invokes no tool", async t => {
  const tools = fakeTools();
  const requests = [];
  const agent = createAgentCore({
    tools,
    model: {
      status: () => ({ enabled: true }),
      plan: async () => ({ toolCalls: [{ id: deleteTool.id, args: { path: "/volume/a.txt" } }], message: "删除文件" })
    },
    requestApproval: async request => {
      requests.push(request);
      return { id: "approval-1", taskId: request.taskId, sessionId: request.sessionId || "" };
    }
  });

  const outcome = await agent.run({ text: "删除 /volume/a.txt" }, { taskId: "task_12345678", sessionId: "session-a" });
  assert.equal(outcome.status, "awaiting-approval");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].taskId, "task_12345678");
  assert.equal(requests[0].sessionId, "session-a");
  assert.equal(requests[0].toolId, deleteTool.id);
  assert.equal(tools.calls.length, 0, "a destructive tool must not run before the confirmation");
});

test("the agent core refuses to run a tool when the task was cancelled or timed out", async t => {
  const tools = fakeTools();
  const agent = createAgentCore({
    tools,
    model: {
      status: () => ({ enabled: true }),
      plan: async () => ({ toolCalls: [{ id: readTool.id, args: {} }], message: "列出文件" })
    },
    requestApproval: async () => ({ id: "approval-1" })
  });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    agent.run({ text: "列出文件" }, { signal: controller.signal, taskId: "task_12345678", sessionId: "session-a" }),
    { code: "TASK_CANCELLED" }
  );
  assert.equal(tools.calls.length, 0, "an aborted task must not execute any tool");
});

test("the server couples approval decisions and cancellations with the task lifecycle", async () => {
  const server = await readFile(new URL("../apps/fnos-nas-agent/app/server.mjs", import.meta.url), "utf8");
  assert.match(server, /taskManager\.resolveApproval\(confirmed\.action\.taskId, \{ status: "completed", result: confirmed\.result \}\)/);
  assert.match(server, /taskManager\.resolveApproval\(revoked\.taskId, \{ status: "cancelled"/);
  assert.match(server, /if \(result\.cancelled\) actionApprovals\.revokeTask\(cancelMatch\[1\]\)/);
  assert.match(server, /taskManager\.submit\(\{ text: input\.text\.trim\(\), history \}, \{ sessionId: active\.key \}\)/);
});

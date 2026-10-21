import test from "node:test";
import assert from "node:assert/strict";
import { createTaskManager } from "../apps/fnos-nas-agent/app/task-manager.mjs";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("tasks move through execution and retain a bounded public result", async () => {
  const manager = createTaskManager({ execute: async input => ({ echoed: input.text }), id: (() => { let n=0; return () => "task-"+(++n); })(), historyLimit: 3 });
  const task = manager.submit({ text: "hello" });
  for (let i=0; i<30 && manager.get(task.taskId).status !== "completed"; i++) await tick();
  assert.equal(manager.get(task.taskId).status, "completed");
  assert.deepEqual(manager.get(task.taskId).result, { echoed: "hello" });
  assert.equal(manager.get("missing"), null);
});

test("task manager enforces concurrency and queue limits", async () => {
  let release;
  const blocker = new Promise(resolve => { release = resolve; });
  const manager = createTaskManager({ concurrency: 1, queueLimit: 1, execute: async input => { if (input.wait) await blocker; return { ok: true }; } });
  manager.submit({ wait: true });
  manager.submit({ wait: false });
  assert.throws(() => manager.submit({ wait: false }), { statusCode: 429 });
  await tick();
  assert.equal(manager.stats().running, 1);
  assert.equal(manager.stats().queued, 1);
  release();
});

test("task failures are sanitized and history is bounded", async () => {
  const manager = createTaskManager({ historyLimit: 2, execute: async input => { if (input.fail) throw new Error("password=private"); return { ok: true }; } });
  const first = manager.submit({ fail: true });
  for (let i=0; i<30 && manager.get(first.taskId)?.status !== "failed"; i++) await tick();
  const second = manager.submit({});
  for (let i=0; i<30 && manager.get(second.taskId)?.status !== "completed"; i++) await tick();
  manager.submit({});
  for (let i=0; i<30 && manager.stats().running + manager.stats().queued; i++) await tick();
  assert.ok(manager.list().length <= 2);
  assert.ok(!JSON.stringify(manager.list()).includes("private"));
  assert.ok(manager.list().every(task => ["completed", "failed"].includes(task.status)));
});

test("task manager rejects invalid concurrency", () => {
  assert.throws(() => createTaskManager({ execute: () => {}, concurrency: 0 }), TypeError);
});

test("history limit retains the newest completed tasks without rejecting submissions", async () => {
  const manager = createTaskManager({
    historyLimit: 2,
    execute: async input => {
      if (input.fail) throw new Error("password=must-not-leak");
      return { ok: true };
    },
    id: (() => { let n = 0; return () => "history-" + (++n); })()
  });
  const first = manager.submit({ fail: true });
  const second = manager.submit({});
  const third = manager.submit({});
  for (let i = 0; i < 50 && !manager.get(third.taskId)?.completedAt; i++) await tick();
  assert.equal(manager.get(first.taskId), null);
  assert.equal(manager.get(second.taskId)?.status, "completed");
  assert.equal(manager.get(third.taskId)?.status, "completed");
  assert.equal(manager.list().length, 2);
  assert.ok(!JSON.stringify(manager.list()).includes("must-not-leak"));
});

test("task history queries filter by status and paginate without exposing inputs", async () => {
  const manager = createTaskManager({
    execute: async input => { if (input.fail) throw new Error("private input"); return { ok: true }; },
    id: (() => { let n = 0; return () => "query-task-" + (++n); })(),
    historyLimit: 10
  });
  const failed = manager.submit({ fail: true, secret: "do-not-return" });
  const completedA = manager.submit({ secret: "also-private" });
  const completedB = manager.submit({});
  for (let i = 0; i < 100 && [failed, completedA, completedB].some(task => !["completed", "failed"].includes(manager.get(task.taskId)?.status)); i++) await tick();
  const all = manager.query({ limit: 2, offset: 0 });
  assert.equal(all.total, 3);
  assert.equal(all.tasks.length, 2);
  assert.equal(all.limit, 2);
  assert.equal(all.offset, 0);
  assert.equal(manager.query({ status: "failed" }).total, 1);
  assert.equal(manager.query({ status: "completed" }).total, 2);
  assert.equal(manager.query({ status: "queued" }).total, 0);
  assert.equal(manager.query({ limit: 1, offset: 1 }).tasks.length, 1);
  assert.equal(JSON.stringify(all).includes("do-not-return"), false);
  assert.equal(JSON.stringify(manager.query({ status: "failed" })).includes("private input"), false);
});

test("clearTerminal removes only terminal tasks and preserves queued/running work", async () => {
  let release;
  const blocker = new Promise(resolve => { release = resolve; });
  const manager = createTaskManager({
    concurrency: 1,
    execute: async input => { if (input.block) await blocker; return { ok: true }; },
    id: (() => { let n = 0; return () => "clear-task-" + (++n); })()
  });
  const completed = manager.submit({});
  for (let i = 0; i < 30 && manager.get(completed.taskId)?.status !== "completed"; i++) await tick();
  const running = manager.submit({ block: true });
  const queued = manager.submit({});
  await tick();
  const result = await manager.clearTerminal();
  assert.equal(result.removed, 1);
  assert.equal(result.retained, 2);
  assert.equal(manager.get(completed.taskId), null);
  assert.equal(manager.get(running.taskId).status, "running");
  assert.equal(manager.get(queued.taskId).status, "queued");
  release();
});

test("task manager bounds oversized retained results while preserving the summary", async () => {
  const manager = createTaskManager({
    execute: async () => ({ message: "查询完成", results: [{ tool: "files.list", result: { names: Array.from({ length: 500 }, (_, i) => "file-" + i + "-" + "x".repeat(200)) } }] })
  });
  const task = manager.submit({});
  for (let i = 0; i < 50 && manager.get(task.taskId)?.status !== "completed"; i++) await tick();
  const stored = manager.get(task.taskId).result;
  assert.equal(stored.message, "查询完成");
  assert.equal(stored.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(stored), "utf8") <= 16 * 1024);
});

test("running task cancellation waits for the active operation and stops cooperative follow-up work", async () => {
  let startedResolve, releaseResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const blocked = new Promise(resolve => { releaseResolve = resolve; });
  const manager = createTaskManager({
    execute: async (_input, context) => {
      startedResolve();
      await blocked;
      if (context.shouldCancel()) throw Object.assign(new Error("private cancellation detail"), { code: "TASK_CANCELLED" });
      return { ok: true };
    }
  });
  const task = manager.submit({});
  await started;
  const requested = manager.cancel(task.taskId);
  assert.equal(requested.cancelled, false);
  assert.equal(requested.cancelRequested, true);
  assert.equal(requested.task.status, "running");
  assert.equal(requested.task.cancelRequested, true);
  releaseResolve();
  for (let i = 0; i < 50 && manager.get(task.taskId)?.status !== "cancelled"; i++) await tick();
  const finalTask = manager.get(task.taskId);
  assert.equal(finalTask.status, "cancelled");
  assert.equal(finalTask.cancelRequested, false);
  assert.match(finalTask.error, /当前工具已结束/);
  assert.doesNotMatch(JSON.stringify(finalTask), /private cancellation detail/);
});

test("task history search filters only safe metadata and combines with status filters", async () => {
  const manager = createTaskManager({
    execute: async input => input.fail ? (() => { throw new Error("sanitized failure"); })() : { ok: true },
    id: (() => { let n = 0; return () => "search-task-" + (++n); })(),
    historyLimit: 10
  });
  const failed = manager.submit({ fail: true, privatePrompt: "never-search-this" });
  const completed = manager.submit({});
  for (let i = 0; i < 100 && [failed, completed].some(task => !["completed", "failed"].includes(manager.get(task.taskId)?.status)); i++) await tick();
  assert.equal(manager.query({ search: "SEARCH-TASK-1" }).total, 1);
  assert.equal(manager.query({ search: "failed" }).total, 1);
  assert.equal(manager.query({ status: "completed", search: "search-task" }).total, 1);
  assert.equal(manager.query({ search: "never-search-this" }).total, 0);
  assert.equal(manager.query({ search: "never-search-this" }).search, "never-search-this");
});

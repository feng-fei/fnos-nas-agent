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

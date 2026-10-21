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
  manager.submit({ fail: true });
  manager.submit({});
  manager.submit({});
  for (let i=0; i<30 && manager.stats().running + manager.stats().queued; i++) await tick();
  assert.ok(manager.list().length <= 2);
  assert.ok(!JSON.stringify(manager.list()).includes("private"));
  assert.ok(manager.list().every(task => ["completed", "failed"].includes(task.status)));
});

test("task manager rejects invalid concurrency", () => {
  assert.throws(() => createTaskManager({ execute: () => {}, concurrency: 0 }), TypeError);
});

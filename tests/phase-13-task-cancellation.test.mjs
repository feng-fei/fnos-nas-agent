import test from "node:test";
import assert from "node:assert/strict";
import { createTaskManager } from "../apps/fnos-nas-agent/app/task-manager.mjs";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("queued task can be cancelled without executing its operation", async () => {
  let release, calls = 0;
  const blocker = new Promise(resolve => { release = resolve; });
  const manager = createTaskManager({
    concurrency: 1,
    id: (() => { let n=0; return () => "task_cancel_" + (++n); })(),
    execute: async input => { calls++; if (input.block) await blocker; return { ok: true }; }
  });
  const running = manager.submit({ block: true });
  const queued = manager.submit({ block: false });
  await tick();
  assert.equal(manager.get(running.taskId).status, "running");
  assert.equal(manager.get(queued.taskId).status, "queued");
  const result = manager.cancel(queued.taskId);
  assert.equal(result.cancelled, true);
  assert.equal(result.task.status, "cancelled");
  assert.equal(manager.get(queued.taskId).error, "任务已取消。");
  assert.equal(calls, 1);
  release();
  for (let i=0;i<30 && manager.get(running.taskId).status!=="completed";i++) await tick();
  assert.equal(calls, 1);
});

test("running, terminal and unknown tasks cannot be cancelled as queued work", async () => {
  let release;
  const blocker = new Promise(resolve => { release = resolve; });
  const manager = createTaskManager({ execute: async () => blocker });
  const task = manager.submit({});
  await tick();
  assert.equal(manager.cancel(task.taskId).cancelled, false);
  assert.equal(manager.cancel("missing"), null);
  release();
});

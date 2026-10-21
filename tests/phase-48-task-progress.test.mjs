import test from "node:test";
import assert from "node:assert/strict";
import { createTaskManager } from "../apps/fnos-nas-agent/app/task-manager.mjs";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("task progress is bounded, monotonic, visible, and reaches 100 on completion", async () => {
  const manager = createTaskManager({
    execute: async (_input, context) => {
      assert.equal(context.reportProgress(25, "正在扫描"), true);
      assert.equal(context.reportProgress(10, "不能回退"), true);
      assert.equal(context.reportProgress(150, "完成前上限"), true);
      assert.equal(context.reportProgress(Number.NaN, "无效"), false);
      return { ok: true };
    }
  });
  const task = manager.submit({ safe: true });
  for (let i = 0; i < 50 && manager.get(task.taskId)?.status !== "completed"; i++) await tick();
  const final = manager.get(task.taskId);
  assert.equal(final.status, "completed");
  assert.equal(final.progress, 100);
  assert.equal(final.stage, "已完成");
  assert.deepEqual(final.result, { ok: true });
});

test("progress stage is length-limited and cancelled tasks cannot report progress", async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const manager = createTaskManager({ concurrency: 1, execute: async (_input, context) => {
    context.reportProgress(40, "x".repeat(200));
    await wait;
    return {};
  }});
  const first = manager.submit({});
  await tick();
  assert.equal(manager.get(first.taskId).progress, 40);
  assert.equal(manager.get(first.taskId).stage.length, 80);
  const queued = manager.submit({});
  assert.equal(manager.cancel(queued.taskId).cancelled, true);
  release();
  for (let i = 0; i < 50 && manager.get(first.taskId)?.status !== "completed"; i++) await tick();
  assert.equal(manager.get(first.taskId).progress, 100);
  assert.equal(manager.get(queued.taskId).progress, 0);
});

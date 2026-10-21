import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskManager } from "../apps/fnos-nas-agent/app/task-manager.mjs";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("task history survives restart without persisting inputs, prompts, results, or raw errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-task-store-"));
  const storageFile = join(dir, "tasks.json");
  const manager = createTaskManager({
    storageFile,
    execute: async () => ({ privateResult: "sensitive-result" }),
    id: () => "persisted-task"
  });
  await manager.ready;
  const task = manager.submit({ text: "private-prompt-do-not-store" });
  for (let i = 0; i < 50 && manager.get(task.taskId)?.status !== "completed"; i++) await tick();
  await manager.flush();

  const raw = await readFile(storageFile, "utf8");
  assert.ok(!raw.includes("private-prompt-do-not-store"));
  assert.ok(!raw.includes("sensitive-result"));
  assert.equal((await stat(storageFile)).mode & 0o777, 0o600);

  const restored = createTaskManager({ storageFile, execute: async () => { throw new Error("must not rerun"); } });
  await restored.ready;
  assert.equal(restored.get("persisted-task").status, "completed");
  assert.equal(restored.get("persisted-task").result, null);
});

test("queued and running tasks are marked interrupted on recovery and never auto-replayed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-task-recovery-"));
  const storageFile = join(dir, "tasks.json");
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let executions = 0;
  const manager = createTaskManager({
    storageFile, concurrency: 1,
    execute: async () => { executions++; await blocked; return { ok: true }; },
    id: (() => { let n = 0; return () => "interrupted-" + (++n); })()
  });
  await manager.ready;
  const running = manager.submit({ text: "do not replay running prompt" });
  const queued = manager.submit({ text: "do not replay queued prompt" });
  await tick();
  await manager.flush();

  const restored = createTaskManager({ storageFile, execute: async () => { throw new Error("replayed"); } });
  await restored.ready;
  assert.equal(restored.get(running.taskId).status, "failed");
  assert.equal(restored.get(queued.taskId).status, "failed");
  assert.match(restored.get(running.taskId).error, /未自动重试/);
  assert.equal(restored.stats().queued, 0);
  assert.equal(restored.stats().running, 0);
  assert.equal(executions, 1);
  assert.ok(! (await readFile(storageFile, "utf8")).includes("do not replay"));
  release();
  await manager.flush();
});

test("task persistence rejects corrupt state rather than silently discarding history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-task-corrupt-"));
  const storageFile = join(dir, "tasks.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(storageFile, "{invalid");
  const manager = createTaskManager({ storageFile, execute: async () => ({}) });
  await assert.rejects(manager.ready);
});

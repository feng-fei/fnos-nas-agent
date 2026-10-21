import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskManager } from "../apps/fnos-nas-agent/app/task-manager.mjs";

test("task snapshot writes recover after a transient filesystem failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "fnos-task-persist-retry-"));
  const stateDir = join(root, "state");
  const storageFile = join(stateDir, "tasks.json");
  const manager = createTaskManager({
    storageFile,
    execute: () => new Promise(() => {}),
    id: () => "retry-persisted-task"
  });

  try {
    await manager.ready;
    // Make the parent path a regular file so the first snapshot write fails deterministically.
    await writeFile(stateDir, "block directory creation", "utf8");
    const task = manager.submit({ text: "must not be persisted" });
    await assert.rejects(manager.flush());

    // Restore the intended directory and verify a later flush can recover the write queue.
    await rm(stateDir, { force: true });
    await mkdir(stateDir, { recursive: true });
    await manager.flush();

    const saved = JSON.parse(await readFile(storageFile, "utf8"));
    assert.ok(saved.tasks.some(item => item.taskId === task.taskId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

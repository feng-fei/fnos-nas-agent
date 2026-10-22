import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskManager } from "../apps/fnos-nas-agent/app/task-manager.mjs";
import { createSkillStore } from "../apps/fnos-nas-agent/app/skills.mjs";

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return null;
}

test("a corrupt task history is quarantined and the service starts with an empty history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-tasks-"));
  const storageFile = join(dir, "tasks.json");
  await writeFile(storageFile, "{invalid", "utf8");
  const manager = createTaskManager({ storageFile, execute: async () => ({ ok: true }) });

  await manager.ready;
  assert.equal(manager.list().length, 0);
  assert.equal(manager.stats().retained, 0);

  const files = await readdir(dir);
  assert.ok(files.some(name => name.startsWith("tasks.json.corrupt-")), "the damaged file must be kept for forensics");
  const backups = files.filter(name => name.startsWith("tasks.json.corrupt-"));
  assert.equal((await readFile(join(dir, backups[0]), "utf8")).includes("invalid"), true);

  // The manager stays usable after the quarantine.
  const task = manager.submit({ text: "hello" });
  const finished = await waitFor(async () => (manager.get(task.taskId).status === "completed" ? manager.get(task.taskId) : null));
  assert.ok(finished, "the task manager must keep working after a quarantine");
  await rm(dir, { recursive: true, force: true });
});

test("a task history with an unexpected shape is quarantined instead of blocking startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-tasks-"));
  const storageFile = join(dir, "tasks.json");
  await writeFile(storageFile, JSON.stringify({ version: 7, tasks: "not-an-array" }), "utf8");
  const manager = createTaskManager({ storageFile, execute: async () => ({}) });
  await manager.ready;
  assert.equal(manager.list().length, 0);
  const files = await readdir(dir);
  assert.ok(files.some(name => name.startsWith("tasks.json.corrupt-")));
  await rm(dir, { recursive: true, force: true });
});

test("a valid task history still restores the interrupted-task semantics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-tasks-"));
  const storageFile = join(dir, "tasks.json");
  const now = "2026-10-22T00:00:00.000Z";
  await writeFile(storageFile, JSON.stringify({
    version: 1,
    tasks: [
      { taskId: "done-task", createdAt: now, startedAt: now, completedAt: now, status: "completed", progress: 100, stage: "已完成", sessionId: "session-a" },
      { taskId: "running-task", createdAt: now, startedAt: now, completedAt: null, status: "running", progress: 40, stage: "执行中" }
    ]
  }), "utf8");

  let executions = 0;
  const manager = createTaskManager({ storageFile, execute: async () => { executions += 1; return {}; } });
  await manager.ready;
  assert.equal(manager.get("done-task").status, "completed");
  assert.equal(manager.get("running-task").status, "failed");
  assert.match(manager.get("running-task").error, /未自动重试/);
  assert.equal(executions, 0, "an interrupted task must never be replayed");
  await rm(dir, { recursive: true, force: true });
});

test("a task history without a session digest still restores with an empty session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-tasks-"));
  const storageFile = join(dir, "tasks.json");
  const now = "2026-10-22T00:00:00.000Z";
  await writeFile(storageFile, JSON.stringify({
    version: 1,
    tasks: [{ taskId: "legacy-task", createdAt: now, startedAt: now, completedAt: now, status: "completed", progress: 100, stage: "已完成" }]
  }), "utf8");
  const manager = createTaskManager({ storageFile, execute: async () => ({}) });
  await manager.ready;
  assert.equal(manager.get("legacy-task").status, "completed");
  await rm(dir, { recursive: true, force: true });
});

test("a corrupt Skill inventory is quarantined and the service continues with an empty list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-skills-"));
  await writeFile(join(dir, "skills.json"), "{invalid", "utf8");
  const store = createSkillStore(dir);
  await store.load();
  assert.equal(store.list().total, 0);
  const files = await readdir(dir);
  assert.ok(files.some(name => name.startsWith("skills.json.corrupt-")), "the damaged inventory must be kept for forensics");
  await rm(dir, { recursive: true, force: true });
});

test("a Skill inventory with an unexpected shape is quarantined instead of blocking startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-skills-"));
  await writeFile(join(dir, "skills.json"), JSON.stringify({ skills: [] }), "utf8");
  const store = createSkillStore(dir);
  await store.load();
  assert.equal(store.list().total, 0);
  const files = await readdir(dir);
  assert.ok(files.some(name => name.startsWith("skills.json.corrupt-")));
  await rm(dir, { recursive: true, force: true });
});

test("a valid Skill inventory is still restored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-skills-"));
  await writeFile(join(dir, "skills.json"), JSON.stringify([
    {
      id: "a".repeat(24), name: "demo", version: "1.0.0", sourceLabel: "local", importedAt: "2026-10-22T00:00:00.000Z",
      archiveSha256: "b".repeat(64), state: "pending_review", quarantineFile: "", declaredCapabilities: []
    }
  ]), "utf8");
  const store = createSkillStore(dir);
  await store.load();
  assert.equal(store.list().total, 1);
  assert.equal(store.list().skills[0].name, "demo");
  await rm(dir, { recursive: true, force: true });
});

test("the task manager stores the session digest and hands it to the executor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-tasks-"));
  const storageFile = join(dir, "tasks.json");
  let received = null;
  const manager = createTaskManager({
    storageFile,
    execute: async (input, context) => { received = context.sessionId; return { ok: true }; }
  });
  const task = manager.submit({ text: "hello" }, { sessionId: "session-digest" });
  const finished = await waitFor(async () => (manager.get(task.taskId).status === "completed" ? manager.get(task.taskId) : null));
  assert.ok(finished);
  assert.equal(received, "session-digest");
  await manager.flush();
  const persisted = JSON.parse(await readFile(storageFile, "utf8"));
  assert.equal(persisted.tasks[0].sessionId, "session-digest");
  await rm(dir, { recursive: true, force: true });
});

test("a task that never finishes is failed with a readable timeout reason", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-tasks-"));
  const storageFile = join(dir, "tasks.json");
  let aborted = false;
  const manager = createTaskManager({
    storageFile,
    taskTimeoutMs: 60,
    execute: async (input, context) => {
      context.signal.addEventListener("abort", () => { aborted = true; });
      return new Promise(() => {});
    }
  });
  const task = manager.submit({ text: "slow" });
  const finished = await waitFor(async () => (manager.get(task.taskId).status === "failed" ? manager.get(task.taskId) : null), 8000);
  assert.ok(finished, "a hanging task must not stay running forever");
  assert.equal(finished.timedOut, true);
  assert.match(finished.error, /超时/);
  assert.equal(aborted, true, "the executor must receive an aborted signal");
  await rm(dir, { recursive: true, force: true });
});

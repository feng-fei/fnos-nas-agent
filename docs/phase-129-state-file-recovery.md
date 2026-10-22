# Phase 129 — State file recovery and durable writes

## 1. The problem

Three state files decide whether the service can start at all, and all three failed
closed on a damaged file:

```js
// apps/fnos-nas-agent/app/task-manager.mjs (before)
const parsed = JSON.parse(raw);
if (parsed?.version !== 1 || !Array.isArray(parsed.tasks)) throw new Error("Invalid task persistence format");
```

```js
// apps/fnos-nas-agent/app/skills.mjs (before)
catch (error) { if (error.code !== "ENOENT") throw new Error("Skill inventory could not be loaded safely"); }
```

`await taskManager.ready` and `await skillStore.load()` sit directly in the startup
sequence of `server.mjs`. A single truncated write — a power cut during a rename, a
full data volume, a filesystem that lost its journal — turned the whole agent into a
process that refuses to boot, and the damaged bytes stayed in place so the next start
failed the same way. The operator had to delete the file by hand, and the previous
task history was lost either way.

The writes themselves were also not durable. Every writer used the same
"write temp file, then rename" pattern, but never flushed the file before the rename
and never flushed the directory afterwards:

```js
// apps/fnos-nas-agent/app/task-manager.mjs (before)
await writeFile(temp, JSON.stringify({ version: 1, tasks: snapshot() }) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
await chmod(temp, 0o600);
await rename(temp, storageFile);
```

The rename is atomic, so a reader never sees a half-written file — but the bytes may
still be only in the page cache when the machine loses power, so the renamed file can
be empty or truncated. That is exactly the corruption this phase has to survive.

Finally, a task that never finished could block the queue forever. `pump()` called the
executor without a deadline, and `concurrency` was 2 while `queueLimit` was 20, so two
hanging tasks stalled every later request with no indication of why.

## 2. Recovery: quarantine instead of refusing to start

Both loaders now treat a damaged file as a recoverable condition. The bytes are kept
next to the original for forensics and the service continues with an empty state.

Task history (`apps/fnos-nas-agent/app/task-manager.mjs`):

```js
const parsed = JSON.parse(raw);   // inside try/catch
if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
  await quarantineStateFile(raw);
  await persist().catch(logPersistFailure);
  return;
}
```

```js
async function quarantineStateFile(raw) {
  const directory = dirname(storageFile);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(directory, basename(storageFile) + ".corrupt-" + stamp + ".json");
  try {
    await rename(storageFile, backup);
    ...
    return;
  } catch (error) { /* fall back to a copy */ }
  try {
    await writeFile(backup, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rm(storageFile, { force: true });
    ...
  } catch (error) { ... }
}
```

Skill inventory (`apps/fnos-nas-agent/app/skills.mjs`) does the same with
`skills.json.corrupt-<timestamp>.json`. Both paths log an explicit `console.error`
line naming the backup file, so the quarantine is visible in the service log rather
than silent.

The recovery semantics that mattered are unchanged: a task that was `queued` or
`running` when the process stopped is still restored as `failed` with

```
服务重启导致任务中断；为避免重复执行，该任务未自动重试。
```

and is never replayed. Only the *unreadable file* case changed — it used to abort the
startup, now it produces an empty history.

## 3. Durable writes

The atomic-write helpers now flush the data before the rename publishes it and flush
the directory afterwards:

```js
// apps/fnos-nas-agent/app/task-manager.mjs
const handle = await open(temp, "wx", 0o600);
try {
  await handle.writeFile(JSON.stringify({ version: 1, tasks: snapshot() }) + "\n", "utf8");
  await handle.sync();
} finally {
  await handle.close();
}
await chmod(temp, 0o600);
await rename(temp, storageFile);
await chmod(storageFile, 0o600);
await syncDirectory(directory);
```

`syncDirectory()` is best effort: opening a directory for reading and syncing it is
not portable, and on platforms that refuse it the rename still provides atomicity.
The same pattern was applied to the Skill inventory
(`apps/fnos-nas-agent/app/skills.mjs`) and to the encrypted model provider store
(`apps/fnos-nas-agent/app/model-provider-store.mjs`).

The Skill store keeps working with a filesystem that has no file handles (the store
accepts an injected `fs` object), so the durable path degrades to a plain write
instead of failing:

```js
async function writeInventoryFile(target, data) {
  if (typeof storageFs.open === "function") {
    const handle = await storageFs.open(target, "wx", 0o600);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  await storageFs.writeFile(target, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
}
```

Background persistence failures are no longer silent:

```js
function logPersistFailure(error) {
  console.error(`[tasks] Task history could not be persisted: ${error?.message || "unknown error"}`);
}
```

`flush()` still rejects when a write fails, so an explicit durability request is never
mistaken for a successful one.

## 4. Bounded tasks and session attribution

A task now carries a deadline. `createTaskManager` accepts `taskTimeoutMs`
(default five minutes, `0` disables it) and the executor receives an
`AbortSignal` next to the existing `shouldCancel()` and `reportProgress()` helpers:

```js
const controller = new AbortController();
const work = Promise.resolve().then(() => execute(task.input, Object.freeze({
  signal: controller.signal,
  sessionId: task.sessionId,
  shouldCancel() { return task.cancelRequested === true; },
  reportProgress(value, stage = "") { ... }
})));
const guarded = task.timeoutMs > 0
  ? Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error("Task execution timed out"), { code: "TASK_TIMEOUT" }));
      }, task.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    })])
  : work;
```

A task that hits the deadline becomes `failed` with a readable reason and never
leaks the raw exception text:

```
任务执行超时（超过 5 分钟），已停止等待结果。
```

`submit()` also takes the session digest of the caller, so a task can be attributed
to the session that started it:

```js
submit(input, context = {}) {
  const sessionId = typeof context?.sessionId === "string" ? context.sessionId.slice(0, MAX_SESSION_ID_LENGTH) : "";
  ...
}
```

The digest is stored on the task, handed back to the executor as `context.sessionId`
and persisted with the snapshot. A snapshot written by an older version — which has
no `sessionId` field — restores with an empty digest instead of failing.

## 5. What the tests cover

`tests/phase-129-state-file-recovery.test.mjs` adds:

* a corrupt `tasks.json` is quarantined, `ready()` resolves, the history is empty and
  the manager still accepts new work;
* a snapshot with an unexpected shape is quarantined the same way;
* a valid snapshot still restores the interrupted-task semantics and is never
  replayed;
* a snapshot without a session digest still restores;
* a corrupt `skills.json` is quarantined and the Skill list is empty;
* a valid Skill inventory is still restored;
* the session digest reaches the executor and the persisted snapshot;
* a task that never finishes is failed with a timeout reason and its signal is
  aborted.

`tests/phase-21-task-persistence.test.mjs` was updated in the same pass: the case
that expected a rejected `ready()` now expects the quarantine.

## 6. Operator notes

* A quarantined file is named `<name>.corrupt-<timestamp>.json` and stays in the
  service data directory. It can be removed once the incident is understood; the
  service does not read it again.
* The service log prints one `console.error` line per quarantine and per failed
  background persist. Those lines are the signal to look at the data volume.
* A timeout is a safety net, not a performance setting. If it fires regularly, the
  agent is asked to do something that does not fit into five minutes; the timeout
  value is configurable per deployment.

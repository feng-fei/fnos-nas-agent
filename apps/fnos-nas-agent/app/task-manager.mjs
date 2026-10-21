import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const INTERRUPTED_ERROR = "服务重启导致任务中断；为避免重复执行，该任务未自动重试。";

export function createTaskManager({ execute, now = () => new Date().toISOString(), id = randomUUID, concurrency = 2, historyLimit = 50, queueLimit = 20, storageFile = "" } = {}) {
  if (typeof execute !== "function") throw new TypeError("execute must be a function");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new TypeError("Invalid concurrency");
  if (!Number.isInteger(historyLimit) || historyLimit < 1) throw new TypeError("Invalid historyLimit");
  if (!Number.isInteger(queueLimit) || queueLimit < 1) throw new TypeError("Invalid queueLimit");
  if (typeof storageFile !== "string") throw new TypeError("Invalid storageFile");
  const tasks = new Map(), queue = [];
  let active = 0;
  let persistQueue = Promise.resolve();
  const publicTask = task => ({ taskId: task.taskId, createdAt: task.createdAt, startedAt: task.startedAt, completedAt: task.completedAt, status: task.status, progress: task.progress, stage: task.stage, result: task.result, error: task.error });

  function prune() {
    const terminal = [...tasks.values()].filter(task => TERMINAL.has(task.status)).sort((a,b) => a.createdAt.localeCompare(b.createdAt));
    while (tasks.size > historyLimit && terminal.length) tasks.delete(terminal.shift().taskId);
  }

  function snapshot() {
    // Never persist task inputs, prompts, results, or raw exception text.
    return [...tasks.values()].map(task => ({
      taskId: task.taskId, createdAt: task.createdAt, startedAt: task.startedAt,
      completedAt: task.completedAt, status: task.status, progress: task.progress, stage: task.stage, error: task.error
    }));
  }

  async function writeSnapshot() {
    if (!storageFile) return;
    const directory = dirname(storageFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = join(directory, "." + randomUUID() + ".tasks.tmp");
    try {
      await writeFile(temp, JSON.stringify({ version: 1, tasks: snapshot() }) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      await chmod(temp, 0o600);
      await rename(temp, storageFile);
      await chmod(storageFile, 0o600);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  function persist() {
    if (!storageFile) return Promise.resolve();
    persistQueue = persistQueue.then(writeSnapshot);
    return persistQueue;
  }

  const ready = (async () => {
    if (!storageFile) return;
    let raw;
    try { raw = await readFile(storageFile, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    await chmod(storageFile, 0o600);
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !Array.isArray(parsed.tasks)) throw new Error("Invalid task persistence format");
    for (const saved of parsed.tasks.slice(-historyLimit)) {
      if (!saved || typeof saved.taskId !== "string" || !saved.taskId || !["queued", "running", "completed", "failed", "cancelled"].includes(saved.status)) continue;
      const interrupted = saved.status === "queued" || saved.status === "running";
      const task = {
        taskId: saved.taskId,
        createdAt: typeof saved.createdAt === "string" ? saved.createdAt : now(),
        startedAt: typeof saved.startedAt === "string" ? saved.startedAt : null,
        completedAt: interrupted ? now() : (typeof saved.completedAt === "string" ? saved.completedAt : null),
        status: interrupted ? "failed" : saved.status,
        progress: Number.isInteger(saved.progress) ? Math.max(0, Math.min(100, saved.progress)) : (saved.status === "completed" ? 100 : 0),
        stage: typeof saved.stage === "string" ? saved.stage.slice(0, 80) : (interrupted ? "服务中断" : ""),
        input: null,
        result: null,
        error: interrupted ? INTERRUPTED_ERROR : (typeof saved.error === "string" ? saved.error : null)
      };
      tasks.set(task.taskId, task);
    }
    prune();
    if (snapshot().some(task => task.error === INTERRUPTED_ERROR)) await persist();
  })();

  function pump() {
    while (active < concurrency && queue.length) {
      const task = queue.shift(); active++; task.status = "running"; task.stage = "执行中"; task.startedAt = now(); void persist().catch(() => {});
      Promise.resolve().then(() => execute(task.input, Object.freeze({
        reportProgress(value, stage = "") {
          if (task.status !== "running" || !Number.isFinite(value)) return false;
          task.progress = Math.max(task.progress, Math.min(99, Math.max(0, Math.floor(value))));
          task.stage = typeof stage === "string" ? stage.trim().slice(0, 80) : "";
          void persist().catch(() => {});
          return true;
        }
      }))).then(
        result => { task.status = "completed"; task.progress = 100; task.stage = "已完成"; task.result = result; },
        error => { task.status = "failed"; task.stage = "执行失败"; task.error = error?.statusCode === 400 ? "请求参数无效。" : "任务执行失败；未执行任意系统命令。"; }
      ).finally(() => { task.completedAt = now(); active--; prune(); void persist().catch(() => {}); pump(); });
    }
  }

  return Object.freeze({
    ready,
    async flush() { await ready; await persist(); await persistQueue; },
    submit(input) {
      if (queue.length >= queueLimit) throw Object.assign(new Error("Task queue is full"), { statusCode: 429 });
      const task = { taskId: id(), createdAt: now(), startedAt: null, completedAt: null, status: "queued", progress: 0, stage: "排队中", input, result: null, error: null };
      tasks.set(task.taskId, task); queue.push(task); void persist().catch(() => {}); pump(); return publicTask(task);
    },
    get(taskId) { const task = tasks.get(taskId); return task ? publicTask(task) : null; },
    cancel(taskId) {
      const task = tasks.get(taskId);
      if (!task) return null;
      if (task.status !== "queued") return { cancelled: false, task: publicTask(task) };
      const index = queue.findIndex(item => item.taskId === taskId);
      if (index < 0) return { cancelled: false, task: publicTask(task) };
      queue.splice(index, 1);
      task.status = "cancelled"; task.completedAt = now(); task.stage = "已取消"; task.error = "任务已取消。";
      prune(); void persist().catch(() => {});
      return { cancelled: true, task: publicTask(task) };
    },
    list({ limit = 20 } = {}) {
      const bounded = Number.isInteger(limit) ? Math.min(50, Math.max(1, limit)) : 20;
      return [...tasks.values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0, bounded).map(publicTask);
    },
    stats() { return { queued: queue.length, running: active, retained: tasks.size, concurrency }; }
  });
}

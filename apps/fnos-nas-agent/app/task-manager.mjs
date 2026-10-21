import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const INTERRUPTED_ERROR = "服务重启导致任务中断；为避免重复执行，该任务未自动重试。";
const MAX_RESULT_BYTES = 16 * 1024;
function boundedTaskResult(value) {
  const state = { remaining: MAX_RESULT_BYTES - 2048, nodes: 0, truncated: false };
  function project(item, depth = 0) {
    if (state.remaining <= 0 || state.nodes >= 250 || depth > 6) {
      state.truncated = true;
      return "[结果已截断]";
    }
    state.nodes++;
    if (item === null || typeof item === "boolean" || typeof item === "number") return item;
    if (typeof item === "string") {
      const max = Math.max(0, Math.min(item.length, state.remaining));
      let result = item.slice(0, max);
      while (result && Buffer.byteLength(result, "utf8") > state.remaining) result = result.slice(0, -1);
      state.remaining -= Buffer.byteLength(result, "utf8");
      if (result.length < item.length) state.truncated = true;
      return result;
    }
    if (Array.isArray(item)) {
      const result = item.slice(0, 40).map(child => project(child, depth + 1));
      if (item.length > result.length) state.truncated = true;
      return result;
    }
    if (typeof item === "object") {
      const result = {};
      const entries = Object.entries(item);
      const priority = ["message", "status", "mode", "tool", "results", "result"];
      entries.sort((a, b) => {
        const ai = priority.indexOf(a[0]), bi = priority.indexOf(b[0]);
        return (ai < 0 ? priority.length : ai) - (bi < 0 ? priority.length : bi);
      });
      for (const [key, child] of entries.slice(0, 40)) {
        if (state.remaining <= 0 || state.nodes >= 250) { state.truncated = true; break; }
        const safeKey = key.slice(0, 80);
        state.remaining = Math.max(0, state.remaining - Buffer.byteLength(safeKey, "utf8"));
        result[safeKey] = project(child, depth + 1);
      }
      if (entries.length > 40) state.truncated = true;
      return result;
    }
    return String(item).slice(0, 100);
  }
  let bounded;
  try { bounded = project(value); }
  catch { return { truncated: true, message: "任务结果无法安全显示。" }; }
  if (!state.truncated) return bounded;
  if (bounded && typeof bounded === "object" && !Array.isArray(bounded)) bounded.truncated = true;
  else bounded = { truncated: true, result: bounded };
  return bounded;
}

export function createTaskManager({ execute, now = () => new Date().toISOString(), id = randomUUID, concurrency = 2, historyLimit = 50, queueLimit = 20, storageFile = "" } = {}) {
  if (typeof execute !== "function") throw new TypeError("execute must be a function");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new TypeError("Invalid concurrency");
  if (!Number.isInteger(historyLimit) || historyLimit < 1) throw new TypeError("Invalid historyLimit");
  if (!Number.isInteger(queueLimit) || queueLimit < 1) throw new TypeError("Invalid queueLimit");
  if (typeof storageFile !== "string") throw new TypeError("Invalid storageFile");
  const tasks = new Map(), queue = [];
  let active = 0;
  let persistQueue = Promise.resolve();
  const publicTask = task => ({ taskId: task.taskId, createdAt: task.createdAt, startedAt: task.startedAt, completedAt: task.completedAt, status: task.status, progress: task.progress, stage: task.stage, cancelRequested: task.cancelRequested === true, result: task.result, error: task.error });

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
        cancelRequested: false,
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
        shouldCancel() { return task.cancelRequested === true; },
        reportProgress(value, stage = "") {
          if (task.status !== "running" || !Number.isFinite(value)) return false;
          task.progress = Math.max(task.progress, Math.min(99, Math.max(0, Math.floor(value))));
          task.stage = task.cancelRequested ? "等待当前工具结束后停止" : (typeof stage === "string" ? stage.trim().slice(0, 80) : "");
          void persist().catch(() => {});
          return true;
        }
      }))).then(
        result => { task.cancelRequested = false; task.status = "completed"; task.progress = 100; task.stage = "已完成"; task.result = boundedTaskResult(result); },
        error => { if (error?.code === "TASK_CANCELLED") { task.cancelRequested = false; task.status = "cancelled"; task.stage = "已取消"; task.error = "任务已取消；当前工具已结束，未继续执行后续步骤。"; } else { task.cancelRequested = false; task.status = "failed"; task.stage = "执行失败"; task.error = error?.statusCode === 400 ? "请求参数无效。" : "任务执行失败；未执行任意系统命令。"; } }
      ).finally(() => { task.completedAt = now(); active--; prune(); void persist().catch(() => {}); pump(); });
    }
  }

  return Object.freeze({
    ready,
    async flush() { await ready; await persist(); await persistQueue; },
    submit(input) {
      if (queue.length >= queueLimit) throw Object.assign(new Error("Task queue is full"), { statusCode: 429 });
      const task = { taskId: id(), createdAt: now(), startedAt: null, completedAt: null, status: "queued", progress: 0, stage: "排队中", cancelRequested: false, input, result: null, error: null };
      tasks.set(task.taskId, task); queue.push(task); void persist().catch(() => {}); pump(); return publicTask(task);
    },
    get(taskId) { const task = tasks.get(taskId); return task ? publicTask(task) : null; },
    cancel(taskId) {
      const task = tasks.get(taskId);
      if (!task) return null;
      if (task.status === "running") {
        if (task.cancelRequested) return { cancelled: false, cancelRequested: true, task: publicTask(task) };
        task.cancelRequested = true;
        task.stage = "等待当前工具结束后停止";
        void persist().catch(() => {});
        return { cancelled: false, cancelRequested: true, task: publicTask(task) };
      }
      if (task.status !== "queued") return { cancelled: false, task: publicTask(task) };
      const index = queue.findIndex(item => item.taskId === taskId);
      if (index < 0) return { cancelled: false, task: publicTask(task) };
      queue.splice(index, 1);
      task.status = "cancelled"; task.completedAt = now(); task.stage = "已取消"; task.error = "任务已取消。";
      prune(); void persist().catch(() => {});
      return { cancelled: true, task: publicTask(task) };
    },
    list({ limit = 20, offset = 0, status } = {}) {
      const bounded = Number.isInteger(limit) ? Math.min(50, Math.max(1, limit)) : 20;
      const skipped = Number.isInteger(offset) ? Math.min(10000, Math.max(0, offset)) : 0;
      return [...tasks.values()]
        .filter(task => !status || task.status === status)
        .sort((a,b) => b.createdAt.localeCompare(a.createdAt))
        .slice(skipped, skipped + bounded).map(publicTask);
    },
    query({ limit = 20, offset = 0, status, search } = {}) {
      const bounded = Number.isInteger(limit) ? Math.min(50, Math.max(1, limit)) : 20;
      const skipped = Number.isInteger(offset) ? Math.min(10000, Math.max(0, offset)) : 0;
      const needle = typeof search === "string" ? search.trim().slice(0, 100).toLocaleLowerCase() : "";
      const filtered = [...tasks.values()].filter(task => {
        if (status && task.status !== status) return false;
        if (!needle) return true;
        return [task.taskId, task.status, task.stage, task.error, task.createdAt, task.completedAt]
          .some(value => typeof value === "string" && value.toLocaleLowerCase().includes(needle));
      }).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
      return { total: filtered.length, limit: bounded, offset: skipped, status: status || null,
        search: needle || null, tasks: filtered.slice(skipped, skipped + bounded).map(publicTask) };
    },
    async clearTerminal() {
      await ready;
      const removed = [...tasks.values()].filter(task => TERMINAL.has(task.status));
      for (const task of removed) tasks.delete(task.taskId);
      try { await persist(); }
      catch {
        for (const task of removed) tasks.set(task.taskId, task);
        throw Object.assign(new Error("Unable to persist task history cleanup"), { statusCode: 500 });
      }
      return { removed: removed.length, retained: tasks.size };
    },
    stats() { return { queued: queue.length, running: active, retained: tasks.size, concurrency }; }
  });
}

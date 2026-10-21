import { randomUUID } from "node:crypto";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
export function createTaskManager({ execute, now = () => new Date().toISOString(), id = randomUUID, concurrency = 2, historyLimit = 50, queueLimit = 20 } = {}) {
  if (typeof execute !== "function") throw new TypeError("execute must be a function");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new TypeError("Invalid concurrency");
  if (!Number.isInteger(historyLimit) || historyLimit < 1) throw new TypeError("Invalid historyLimit");
  if (!Number.isInteger(queueLimit) || queueLimit < 1) throw new TypeError("Invalid queueLimit");
  const tasks = new Map(), queue = [];
  let active = 0;
  const publicTask = task => ({ taskId: task.taskId, createdAt: task.createdAt, startedAt: task.startedAt, completedAt: task.completedAt, status: task.status, result: task.result, error: task.error });
  function prune() {
    const terminal = [...tasks.values()].filter(task => TERMINAL.has(task.status)).sort((a,b) => a.createdAt.localeCompare(b.createdAt));
    while (tasks.size > historyLimit && terminal.length) tasks.delete(terminal.shift().taskId);
  }
  function pump() {
    while (active < concurrency && queue.length) {
      const task = queue.shift(); active++; task.status = "running"; task.startedAt = now();
      Promise.resolve().then(() => execute(task.input)).then(
        result => { task.status = "completed"; task.result = result; },
        error => { task.status = "failed"; task.error = error?.statusCode === 400 ? "请求参数无效。" : "任务执行失败；未执行任意系统命令。"; }
      ).finally(() => { task.completedAt = now(); active--; prune(); pump(); });
    }
  }
  return Object.freeze({
    submit(input) {
      if (queue.length >= queueLimit) throw Object.assign(new Error("Task queue is full"), { statusCode: 429 });
      const task = { taskId: id(), createdAt: now(), startedAt: null, completedAt: null, status: "queued", input, result: null, error: null };
      tasks.set(task.taskId, task); queue.push(task); pump(); return publicTask(task);
    },
    get(taskId) { const task = tasks.get(taskId); return task ? publicTask(task) : null; },
    cancel(taskId) {
      const task = tasks.get(taskId);
      if (!task) return null;
      if (task.status !== "queued") return { cancelled: false, task: publicTask(task) };
      const index = queue.findIndex(item => item.taskId === taskId);
      if (index < 0) return { cancelled: false, task: publicTask(task) };
      queue.splice(index, 1);
      task.status = "cancelled"; task.completedAt = now(); task.error = "任务已取消。";
      prune();
      return { cancelled: true, task: publicTask(task) };
    },
    list({ limit = 20 } = {}) {
      const bounded = Number.isInteger(limit) ? Math.min(50, Math.max(1, limit)) : 20;
      return [...tasks.values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0, bounded).map(publicTask);
    },
    stats() { return { queued: queue.length, running: active, retained: tasks.size, concurrency }; }
  });
}

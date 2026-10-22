import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const INTERRUPTED_ERROR = "服务重启导致任务中断；为避免重复执行，该任务未自动重试。";
const MAX_RESULT_BYTES = 16 * 1024;
const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TASK_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_SESSION_ID_LENGTH = 128;
// The event stream is a metadata channel for the conversation window. It carries
// progress, tool and terminal information only; it never carries the task
// input, the prompt or an unbounded tool result.
const MAX_SUBSCRIBERS_PER_TASK = 32;
const MAX_TOTAL_SUBSCRIBERS = 1024;
const MAX_TOOL_EVENT_BYTES = MAX_RESULT_BYTES;
// The public shape of a task. It is exported so the HTTP layer and the event
// stream describe a task in exactly the same way. The fields are part of the
// contract and must not change silently.
export function publicTask(task) {
  return { taskId: task.taskId, createdAt: task.createdAt, startedAt: task.startedAt, completedAt: task.completedAt, status: task.status, progress: task.progress, stage: task.stage, cancelRequested: task.cancelRequested === true, timeoutMs: task.timeoutMs, timedOut: task.timedOut === true, result: task.result, error: task.error };
}
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

export function createTaskManager({ execute, now = () => new Date().toISOString(), id = randomUUID, concurrency = 2, historyLimit = 50, queueLimit = 20, storageFile = "", taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS } = {}) {
  if (typeof execute !== "function") throw new TypeError("execute must be a function");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new TypeError("Invalid concurrency");
  if (!Number.isInteger(historyLimit) || historyLimit < 1) throw new TypeError("Invalid historyLimit");
  if (!Number.isInteger(queueLimit) || queueLimit < 1) throw new TypeError("Invalid queueLimit");
  if (typeof storageFile !== "string") throw new TypeError("Invalid storageFile");
  if (!Number.isInteger(taskTimeoutMs) || taskTimeoutMs < 0 || taskTimeoutMs > MAX_TASK_TIMEOUT_MS) throw new TypeError("Invalid taskTimeoutMs");
  const tasks = new Map(), queue = [];
  let active = 0;
  let persistQueue = Promise.resolve();
  // Set when the task history could not be restored and the service continued with an
  // empty history. The operator can see the difference between a normal and a
  // degraded start.
  let degradedState = false;
  // Task id -> Set of listeners. A listener only ever receives the events of
  // the task it subscribed to.
  const subscribers = new Map();
  let subscriberCount = 0;

  function eventListeners(taskId) {
    const listeners = subscribers.get(taskId);
    return listeners ? [...listeners] : [];
  }

  function emit(taskId, type, data) {
    const listeners = eventListeners(taskId);
    if (!listeners.length) return;
    const event = Object.freeze({ type, at: now(), data });
    for (const listener of listeners) {
      // A broken listener must never break the task it observes.
      try { listener(event); }
      catch (error) { console.error("[tasks] Task event listener failed:", error?.message || "unknown error"); }
    }
  }

  function byteSize(value) {
    try { return Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8"); }
    catch { return MAX_RESULT_BYTES; }
  }

  // The tool results of one task share a single budget: a plan with many tools
  // must not be able to push more than the result cap through the event stream.
  function toolEventResult(task, value) {
    const bounded = boundedTaskResult(value);
    const size = byteSize(bounded);
    const used = typeof task.toolBytes === "number" ? task.toolBytes : 0;
    if (used + size > MAX_RESULT_BYTES) return { truncated: true, message: "结果已截断。" };
    task.toolBytes = used + size;
    return bounded;
  }

  function dropSubscribers(taskId) {
    const listeners = subscribers.get(taskId);
    if (!listeners) return;
    subscriberCount -= listeners.size;
    subscribers.delete(taskId);
  }

  // A terminal task closes the stream with exactly one final event. A failure
  // ends with "error" so the client learns the reason, every other terminal
  // state ends with "done". The HTTP layer treats both as the end of the
  // stream, so a second final event would be written to a closed stream.
  function terminalEvents(task) {
    if (task.status === "failed") return [{ type: "error", data: { message: task.error || "任务执行失败。" } }];
    return [{ type: "done", data: { task: publicTask(task) } }];
  }

  // The event stream is a metadata channel. It reports what happened, never the
  // task input, the prompt or an unbounded tool result.
  function finishTask(task) {
    if (!TERMINAL.has(task.status)) return;
    for (const event of terminalEvents(task)) emit(task.taskId, event.type, event.data);
    // A finished task never produces another event.
    dropSubscribers(task.taskId);
  }

  function reportToolEvent(task, tool, result) {
    const name = typeof tool === "string" ? tool.slice(0, 80) : "";
    if (!name) return false;
    if (!Array.isArray(task.reportedTools)) task.reportedTools = [];
    task.reportedTools.push(name);
    emit(task.taskId, "tool", { tool: name, result: toolEventResult(task, result) });
    return true;
  }

  // The executor may report every tool on its own through the execution
  // context. When it does not, the finished result is used as a fallback
  // source so the stream still shows which tools ran. Tools that were already
  // reported are not repeated.
  function reportToolEventsFromResult(task, raw) {
    const list = Array.isArray(raw?.results) ? raw.results : [];
    if (!list.length) return;
    const reported = Array.isArray(task.reportedTools) ? [...task.reportedTools] : [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const name = typeof entry.tool === "string" ? entry.tool.slice(0, 80) : "";
      if (!name) continue;
      const index = reported.indexOf(name);
      if (index >= 0) { reported.splice(index, 1); continue; }
      if (!Array.isArray(task.reportedTools)) task.reportedTools = [];
      task.reportedTools.push(name);
      emit(task.taskId, "tool", { tool: name, result: toolEventResult(task, entry.result) });
    }
  }

  function prune() {
    const terminal = [...tasks.values()].filter(task => TERMINAL.has(task.status)).sort((a,b) => a.createdAt.localeCompare(b.createdAt));
    while (tasks.size > historyLimit && terminal.length) tasks.delete(terminal.shift().taskId);
  }

  function snapshot() {
    // Never persist task inputs, prompts, results, or raw exception text.
    return [...tasks.values()].map(task => ({
      taskId: task.taskId, createdAt: task.createdAt, startedAt: task.startedAt,
      completedAt: task.completedAt, status: task.status, progress: task.progress, stage: task.stage,
      sessionId: typeof task.sessionId === "string" ? task.sessionId : "", error: task.error
    }));
  }

  function ownsTask(task, sessionId) {
    // A task without a session (legacy history) stays visible; a task that belongs to
    // another session is invisible and cannot be cancelled.
    const scope = typeof sessionId === "string" ? sessionId : "";
    if (!scope) return true;
    return !task.sessionId || task.sessionId === scope;
  }

  function logPersistFailure(error) {
    console.error(`[tasks] Task history could not be persisted: ${error?.message || "unknown error"}`);
  }

  async function syncDirectory(directory) {
    // Directory fsync is not available on every platform; the rename is still atomic.
    let handle = null;
    try {
      handle = await open(directory, "r");
      await handle.sync();
    } catch {
      // best effort only
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function writeSnapshot() {
    if (!storageFile) return;
    const directory = dirname(storageFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = join(directory, "." + randomUUID() + ".tasks.tmp");
    try {
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
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  function persist() {
    if (!storageFile) return Promise.resolve();
    // A transient filesystem error must not poison every later snapshot write.
    persistQueue = persistQueue.catch(() => {}).then(writeSnapshot);
    return persistQueue;
  }

  async function quarantineStateFile(raw) {
    // A damaged state file must never block startup: keep the bytes for forensics and
    // continue with an empty task history.
    degradedState = true;
    const directory = dirname(storageFile);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = join(directory, basename(storageFile) + ".corrupt-" + stamp + ".json");
    try {
      await rename(storageFile, backup);
      console.error(`[tasks] Corrupt task history was quarantined as ${basename(backup)}; the service continues with an empty task history.`);
      return;
    } catch (error) {
      console.error(`[tasks] Corrupt task history could not be moved aside (${error?.message || "unknown error"}); a copy is attempted instead.`);
    }
    try {
      await writeFile(backup, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rm(storageFile, { force: true });
      console.error(`[tasks] Corrupt task history was copied to ${basename(backup)}; the service continues with an empty task history.`);
    } catch (error) {
      console.error(`[tasks] Corrupt task history could not be quarantined (${error?.message || "unknown error"}); the service continues with an empty task history.`);
    }
  }

  const ready = (async () => {
    if (!storageFile) return;
    let raw;
    try { raw = await readFile(storageFile, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    await chmod(storageFile, 0o600).catch(() => {});
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
      await quarantineStateFile(raw);
      await persist().catch(logPersistFailure);
      return;
    }
    for (const saved of parsed.tasks.slice(-historyLimit)) {
      if (!saved || typeof saved.taskId !== "string" || !saved.taskId || !["queued", "running", "awaiting-approval", "completed", "failed", "cancelled"].includes(saved.status)) continue;
      // A task that was waiting for a destructive confirmation cannot be resumed after a
      // restart: the approval grant only lives in memory, so it counts as interrupted.
      const interrupted = saved.status === "queued" || saved.status === "running" || saved.status === "awaiting-approval";
      const task = {
        taskId: saved.taskId,
        createdAt: typeof saved.createdAt === "string" ? saved.createdAt : now(),
        startedAt: typeof saved.startedAt === "string" ? saved.startedAt : null,
        completedAt: interrupted ? now() : (typeof saved.completedAt === "string" ? saved.completedAt : null),
        status: interrupted ? "failed" : saved.status,
        progress: Number.isInteger(saved.progress) ? Math.max(0, Math.min(100, saved.progress)) : (saved.status === "completed" ? 100 : 0),
        stage: typeof saved.stage === "string" ? saved.stage.slice(0, 80) : (interrupted ? "服务中断" : ""),
        sessionId: typeof saved.sessionId === "string" ? saved.sessionId.slice(0, MAX_SESSION_ID_LENGTH) : "",
        timeoutMs: taskTimeoutMs,
        timedOut: false,
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

  function timeoutMessage(task) {
    const minutes = Math.max(1, Math.round((task.timeoutMs || DEFAULT_TASK_TIMEOUT_MS) / 60000));
    return `任务执行超时（超过 ${minutes} 分钟），已停止等待结果。`;
  }

  function pump() {
    while (active < concurrency && queue.length) {
      const task = queue.shift(); active++; task.status = "running"; task.stage = "执行中"; task.startedAt = now(); void persist().catch(logPersistFailure);
      const controller = new AbortController();
      const work = Promise.resolve().then(() => execute(task.input, Object.freeze({
        signal: controller.signal,
        sessionId: task.sessionId,
        taskId: task.taskId,
        shouldCancel() { return task.cancelRequested === true; },
        reportProgress(value, stage = "") {
          if (task.status !== "running" || !Number.isFinite(value)) return false;
          task.progress = Math.max(task.progress, Math.min(99, Math.max(0, Math.floor(value))));
          task.stage = task.cancelRequested ? "等待当前工具结束后停止" : (typeof stage === "string" ? stage.trim().slice(0, 80) : "");
          void persist().catch(logPersistFailure);
          emit(task.taskId, "progress", { progress: task.progress, stage: task.stage });
          return true;
        },
        // The executor reports a finished tool here. The result is bounded before
        // it reaches the stream, so a large tool output cannot flood a client.
        reportTool(tool, result) {
          if (task.status !== "running") return false;
          return reportToolEvent(task, tool, result);
        }
      })));
      // A late failure after the task already timed out must not become an unhandled rejection.
      work.catch(() => {});
      let timer = null;
      const guarded = task.timeoutMs > 0
        ? Promise.race([work, new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Object.assign(new Error("Task execution timed out"), { code: "TASK_TIMEOUT" }));
          }, task.timeoutMs);
          if (typeof timer.unref === "function") timer.unref();
        })])
        : work;
      guarded.then(
        result => {
          task.cancelRequested = false;
          const reported = typeof result?.status === "string" ? result.status : "";
          if (reported === "awaiting-approval") {
            // The task stays open until the operator confirms or denies the pending
            // destructive action. It is not a terminal state, so it is not pruned.
            task.status = "awaiting-approval";
            task.stage = "等待确认";
            task.progress = Math.min(task.progress, 99);
            task.result = boundedTaskResult(result);
            // The approval is announced explicitly so the conversation window can
            // show the pending confirmation without polling the task.
            emit(task.taskId, "approval", { task: publicTask(task) });
            return;
          }
          // The executor may not report its tools one by one. The finished result
          // is used as a fallback so the stream still shows what ran.
          reportToolEventsFromResult(task, result);
          if (reported === "failed") {
            task.status = "failed";
            task.stage = "执行失败";
            task.error = typeof result?.message === "string" ? result.message.slice(0, 200) : "任务执行失败；未执行任意系统命令。";
            task.result = boundedTaskResult(result);
            return;
          }
          task.status = "completed"; task.progress = 100; task.stage = "已完成"; task.result = boundedTaskResult(result);
        },
        error => {
          task.cancelRequested = false;
          if (error?.code === "TASK_CANCELLED") { task.status = "cancelled"; task.stage = "已取消"; task.error = "任务已取消；当前工具已结束，未继续执行后续步骤。"; }
          else if (error?.code === "TASK_TIMEOUT") { task.status = "failed"; task.stage = "执行超时"; task.timedOut = true; task.error = timeoutMessage(task); }
          else { task.status = "failed"; task.stage = "执行失败"; task.error = error?.statusCode === 400 ? "请求参数无效。" : "任务执行失败；未执行任意系统命令。"; }
        }
      ).finally(() => {
        if (timer) clearTimeout(timer);
        if (TERMINAL.has(task.status)) task.completedAt = now();
        // A task that reached a terminal state closes the event stream.
        finishTask(task);
        active--; prune(); void persist().catch(logPersistFailure); pump();
      });
    }
  }

  return Object.freeze({
    ready,
    degraded: () => degradedState,
    async flush() { await ready; await persist(); await persistQueue; },
    // The event stream of one task. The returned function removes the listener
    // again. It returns null when the stream cannot be opened, so the caller
    // can answer with a clean error instead of crashing.
    subscribe(taskId, listener) {
      if (typeof taskId !== "string" || !taskId) return null;
      if (typeof listener !== "function") return null;
      const existing = subscribers.get(taskId);
      if (existing && existing.size >= MAX_SUBSCRIBERS_PER_TASK) return null;
      if (subscriberCount >= MAX_TOTAL_SUBSCRIBERS) return null;
      // A task that already finished never produces another event. The caller is
      // told once so the client does not wait for a stream that will stay silent.
      const task = tasks.get(taskId);
      if (task && TERMINAL.has(task.status)) {
        for (const event of terminalEvents(task)) {
          try { listener(Object.freeze({ type: event.type, at: now(), data: event.data })); }
          catch (error) { console.error("[tasks] Task event listener failed:", error?.message || "unknown error"); }
        }
        return () => {};
      }
      // A task that is already waiting for a confirmation will not announce it
      // again. The pending state is delivered once so the client can show it.
      if (task && task.status === "awaiting-approval") {
        try { listener(Object.freeze({ type: "approval", at: now(), data: { task: publicTask(task) } })); }
        catch (error) { console.error("[tasks] Task event listener failed:", error?.message || "unknown error"); }
      }
      if (!subscribers.has(taskId)) subscribers.set(taskId, new Set());
      const listeners = subscribers.get(taskId);
      const before = listeners.size;
      listeners.add(listener);
      // The same listener may be registered twice. The set keeps one entry, so
      // the global counter only grows when the set really grew.
      if (listeners.size > before) subscriberCount++;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const current = subscribers.get(taskId);
        if (!current) return;
        if (current.delete(listener)) subscriberCount = Math.max(0, subscriberCount - 1);
        if (!current.size) subscribers.delete(taskId);
      };
    },
    // The number of open listeners of one task. It is used by the tests and by
    // the diagnostics endpoint.
    subscriberCount(taskId) { return subscribers.get(taskId)?.size || 0; },
    submit(input, context = {}) {
      if (queue.length >= queueLimit) throw Object.assign(new Error("Task queue is full"), { statusCode: 429 });
      const sessionId = typeof context?.sessionId === "string" ? context.sessionId.slice(0, MAX_SESSION_ID_LENGTH) : "";
      const task = { taskId: id(), createdAt: now(), startedAt: null, completedAt: null, status: "queued", progress: 0, stage: "排队中", cancelRequested: false, sessionId, timeoutMs: taskTimeoutMs, timedOut: false, input, result: null, error: null };
      tasks.set(task.taskId, task); queue.push(task); void persist().catch(logPersistFailure); pump(); return publicTask(task);
    },
    get(taskId, sessionId = "") { const task = tasks.get(taskId); if (!task || !ownsTask(task, sessionId)) return null; return publicTask(task); },
    cancel(taskId, sessionId = "") {
      const task = tasks.get(taskId);
      if (!task || !ownsTask(task, sessionId)) return null;
      if (task.status === "running") {
        if (task.cancelRequested) return { cancelled: false, cancelRequested: true, task: publicTask(task) };
        task.cancelRequested = true;
        task.stage = "等待当前工具结束后停止";
        void persist().catch(logPersistFailure);
        return { cancelled: false, cancelRequested: true, task: publicTask(task) };
      }
      if (task.status === "awaiting-approval") {
        task.status = "cancelled"; task.completedAt = now(); task.stage = "已取消"; task.error = "任务已取消；待确认的操作已撤销。";
        finishTask(task);
        prune(); void persist().catch(logPersistFailure);
        return { cancelled: true, task: publicTask(task) };
      }
      if (task.status !== "queued") return { cancelled: false, task: publicTask(task) };
      const index = queue.findIndex(item => item.taskId === taskId);
      if (index < 0) return { cancelled: false, task: publicTask(task) };
      queue.splice(index, 1);
      task.status = "cancelled"; task.completedAt = now(); task.stage = "已取消"; task.error = "任务已取消。";
      finishTask(task);
      prune(); void persist().catch(logPersistFailure);
      return { cancelled: true, task: publicTask(task) };
    },
    list({ limit = 20, offset = 0, status, sessionId = "" } = {}) {
      const bounded = Number.isInteger(limit) ? Math.min(50, Math.max(1, limit)) : 20;
      const skipped = Number.isInteger(offset) ? Math.min(10000, Math.max(0, offset)) : 0;
      return [...tasks.values()]
        .filter(task => !status || task.status === status)
        .filter(task => ownsTask(task, sessionId))
        .sort((a,b) => b.createdAt.localeCompare(a.createdAt))
        .slice(skipped, skipped + bounded).map(publicTask);
    },
    query({ limit = 20, offset = 0, status, search, sessionId = "" } = {}) {
      const bounded = Number.isInteger(limit) ? Math.min(50, Math.max(1, limit)) : 20;
      const skipped = Number.isInteger(offset) ? Math.min(10000, Math.max(0, offset)) : 0;
      const needle = typeof search === "string" ? search.trim().slice(0, 100).toLocaleLowerCase() : "";
      const filtered = [...tasks.values()].filter(task => {
        if (!ownsTask(task, sessionId)) return false;
        if (status && task.status !== status) return false;
        if (!needle) return true;
        return [task.taskId, task.status, task.stage, task.error, task.createdAt, task.completedAt]
          .some(value => typeof value === "string" && value.toLocaleLowerCase().includes(needle));
      }).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
      return { total: filtered.length, limit: bounded, offset: skipped, status: status || null,
        search: needle || null, tasks: filtered.slice(skipped, skipped + bounded).map(publicTask) };
    },
    async clearTerminal(sessionId = "") {
      await ready;
      const removed = [...tasks.values()].filter(task => TERMINAL.has(task.status) && ownsTask(task, sessionId));
      for (const task of removed) tasks.delete(task.taskId);
      try { await persist(); }
      catch {
        for (const task of removed) tasks.set(task.taskId, task);
        throw Object.assign(new Error("Unable to persist task history cleanup"), { statusCode: 500 });
      }
      return { removed: removed.length, retained: tasks.size };
    },
    resolveApproval(taskId, outcome = {}) {
      // The operator confirmed or denied a pending destructive action. The task that
      // requested it now reaches its real terminal state.
      const task = tasks.get(taskId);
      if (!task) return { updated: false, task: null };
      if (task.status !== "awaiting-approval") return { updated: false, task: publicTask(task) };
      const wanted = outcome?.status === "failed" ? "failed" : outcome?.status === "cancelled" ? "cancelled" : "completed";
      task.status = wanted;
      task.stage = wanted === "cancelled" ? "已取消" : wanted === "failed" ? "执行失败" : "已完成";
      if (wanted === "completed") task.progress = 100;
      task.completedAt = now();
      if (outcome && typeof outcome.result !== "undefined") task.result = boundedTaskResult(outcome.result);
      if (typeof outcome?.error === "string" && outcome.error) task.error = outcome.error.slice(0, 200);
      // The task reached its real terminal state: the stream ends here.
      finishTask(task);
      prune(); void persist().catch(logPersistFailure);
      return { updated: true, task: publicTask(task) };
    },
    stats() { return { queued: queue.length, running: active, retained: tasks.size, concurrency }; }
  });
}

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

const VERSION = 1;
const STATE_FILE = "scheduled-health-checks.json";
const MAX_CHECKS = 20;
const MAX_HISTORY = 10;
const MAX_STATE_BYTES = 512 * 1024;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 10080;
const TICK_MS = 15000;
const TYPES = new Set(["system", "storage", "network", "docker", "documents"]);
const TYPE_LABELS = Object.freeze({
  system: "系统健康",
  storage: "存储健康",
  network: "网络状态",
  docker: "Docker 状态",
  documents: "文档库状态"
});

function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}
function safeStatus(value) {
  return ["ok", "warning", "error"].includes(value) ? value : "error";
}
function cleanName(value) {
  if (typeof value !== "string") return "";
  const name = value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80);
  return name;
}
function validateDefinition(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, "巡检计划参数无效。");
  if (Object.keys(input).some(key => !["name", "type", "intervalMinutes", "enabled"].includes(key)))
    fail(400, "巡检计划包含不支持的字段。");
  const name = cleanName(input.name);
  if (!name) fail(400, "巡检计划名称不能为空。");
  if (!TYPES.has(input.type)) fail(400, "巡检类型不受支持。");
  const intervalMinutes = input.intervalMinutes;
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < MIN_INTERVAL_MINUTES || intervalMinutes > MAX_INTERVAL_MINUTES)
    fail(400, "巡检间隔必须为 5 到 10080 分钟。");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") fail(400, "enabled 必须是布尔值。");
  return { name, type: input.type, intervalMinutes, enabled: input.enabled !== false };
}
function safeHistoryItem(item) {
  return {
    at: String(item.at || ""),
    status: safeStatus(item.status),
    summary: String(item.summary || "").slice(0, 500),
    findings: Array.isArray(item.findings) ? item.findings.filter(x => typeof x === "string").slice(0, 10).map(x => x.slice(0, 160)) : [],
    durationMs: Number.isFinite(item.durationMs) ? Math.max(0, Math.min(60000, Math.trunc(item.durationMs))) : 0
  };
}
function validateSavedState(value) {
  if (!value || value.version !== VERSION || !Array.isArray(value.checks) || value.checks.length > MAX_CHECKS)
    fail(503, "定时巡检记录格式无效；请检查应用数据文件。");
  const ids = new Set();
  const checks = [];
  for (const item of value.checks) {
    if (!item || typeof item.id !== "string" || !/^[a-f0-9-]{36}$/i.test(item.id) || ids.has(item.id)) continue;
    if (typeof item.name !== "string" || !TYPES.has(item.type) ||
        !Number.isInteger(item.intervalMinutes) || item.intervalMinutes < MIN_INTERVAL_MINUTES || item.intervalMinutes > MAX_INTERVAL_MINUTES ||
        typeof item.enabled !== "boolean") continue;
    ids.add(item.id);
    checks.push({
      id: item.id, name: cleanName(item.name) || TYPE_LABELS[item.type], type: item.type,
      intervalMinutes: item.intervalMinutes, enabled: item.enabled,
      createdAt: String(item.createdAt || ""), updatedAt: String(item.updatedAt || ""),
      nextRunAt: item.nextRunAt ? String(item.nextRunAt) : null,
      lastRunAt: item.lastRunAt ? String(item.lastRunAt) : null,
      lastStatus: item.lastStatus ? safeStatus(item.lastStatus) : null,
      lastSummary: String(item.lastSummary || "").slice(0, 500),
      history: Array.isArray(item.history) ? item.history.slice(-MAX_HISTORY).map(safeHistoryItem) : []
    });
  }
  return { version: VERSION, checks };
}
function emptyState() { return { version: VERSION, checks: [] }; }

export function createScheduledHealthChecks({
  dataDir,
  runTool,
  now = () => new Date(),
  id = randomUUID,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  if (typeof dataDir !== "string" || !dataDir.trim()) throw new TypeError("dataDir is required");
  if (typeof runTool !== "function") throw new TypeError("runTool must be a function");
  if (typeof now !== "function" || typeof id !== "function") throw new TypeError("now and id must be functions");

  const statePath = join(dataDir, STATE_FILE);
  let checks = [];
  let timer = null;
  let tickRunning = false;
  const running = new Set();
  let persistQueue = Promise.resolve();
  const clock = () => {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("now returned an invalid date");
    return date;
  };
  const timestamp = () => clock().toISOString();

  async function load() {
    let handle;
    try {
      handle = await open(statePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_STATE_BYTES) fail(503, "定时巡检记录不是受限的普通文件。");
      const parsed = JSON.parse(await handle.readFile({ encoding: "utf8" }));
      checks = validateSavedState(parsed).checks;
      await handle.chmod(0o600);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      if (error instanceof SyntaxError || error?.statusCode === 503) {
        console.error("[health-checks] State file is invalid; scheduled checks are disabled until it is repaired.");
        checks = [];
        return;
      }
      console.error("[health-checks] State could not be loaded; scheduled checks start empty.");
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function persist() {
    const snapshot = JSON.stringify({ version: VERSION, checks }) + "\n";
    if (Buffer.byteLength(snapshot, "utf8") > MAX_STATE_BYTES) fail(413, "定时巡检历史达到存储上限，请清理部分巡检计划。");
    const directory = dataDir;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = join(directory, ".health-checks-" + id() + ".tmp");
    let handle;
    let renamed = false;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(snapshot, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temp, statePath);
      renamed = true;
      await chmod(statePath, 0o600);
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (!renamed) await rm(temp, { force: true }).catch(() => {});
    }
  }
  function queuePersist() {
    persistQueue = persistQueue.catch(() => {}).then(persist);
    return persistQueue;
  }
  function publicCheck(item) {
    return {
      id: item.id, name: item.name, type: item.type, typeLabel: TYPE_LABELS[item.type],
      intervalMinutes: item.intervalMinutes, enabled: item.enabled,
      createdAt: item.createdAt, updatedAt: item.updatedAt,
      nextRunAt: item.enabled ? item.nextRunAt : null,
      lastRunAt: item.lastRunAt, lastStatus: item.lastStatus,
      lastSummary: item.lastSummary, history: item.history.slice(-MAX_HISTORY)
    };
  }
  function list() {
    return { checks: checks.map(publicCheck), total: checks.length, maxChecks: MAX_CHECKS,
      minIntervalMinutes: MIN_INTERVAL_MINUTES, maxIntervalMinutes: MAX_INTERVAL_MINUTES };
  }
  function getCheck(checkId) {
    const item = checks.find(check => check.id === checkId);
    if (!item) fail(404, "未找到该定时巡检。");
    return item;
  }
  function scheduleNext(item, from = clock()) {
    item.nextRunAt = new Date(from.getTime() + item.intervalMinutes * 60000).toISOString();
  }

  async function evaluateCheck(item) {
    const started = clock();
    const findings = [];
    let status = "ok";
    let summary = "";
    try {
      if (item.type === "system") {
        const result = await runTool("system.status", {});
        const memory = result?.memory || {};
        const total = Number(memory.totalBytes);
        const used = Number(memory.usedBytes);
        const memoryPercent = total > 0 && Number.isFinite(used) ? Math.round(used / total * 100) : null;
        const cores = Number(result?.cpu?.logicalCores);
        const load = Array.isArray(result?.cpu?.loadAverage) ? Number(result.cpu.loadAverage[0]) : NaN;
        if (memoryPercent !== null && memoryPercent >= 90) findings.push("内存使用率达到或超过 90%");
        if (cores > 0 && Number.isFinite(load) && load >= cores * 1.5) findings.push("CPU 1 分钟负载明显高于逻辑核心数");
        status = findings.length ? "warning" : "ok";
        summary = "系统健康检查完成；内存使用率 " + (memoryPercent === null ? "未知" : memoryPercent + "%") +
          (Number.isFinite(load) && cores > 0 ? "；CPU 1 分钟负载 " + load.toFixed(2) + " / " + cores + " 核" : "");
      } else if (item.type === "storage") {
        const result = await runTool("storage.summary", {});
        const storage = Array.isArray(result?.storage) ? result.storage : [];
        if (!storage.length) {
          status = "warning";
          findings.push("没有可用的存储容量数据");
        }
        const hot = [];
        for (const disk of storage) {
          const total = Number(disk?.totalBytes);
          const used = Number(disk?.usedBytes);
          if (disk?.available === false || !(total > 0) || !Number.isFinite(used)) continue;
          const percent = Math.round(used / total * 100);
          if (percent >= 90) hot.push(String(disk.label || "存储卷") + " " + percent + "%");
        }
        if (hot.length) findings.push(...hot.slice(0, 5).map(x => x + " 使用率达到 90%"));
        if (findings.length) status = "warning";
        summary = storage.length
          ? "存储容量检查完成；检查 " + storage.length + " 个文件系统" + (hot.length ? "；高使用率：" + hot.slice(0, 3).join("、") : "；未发现使用率达到 90% 的文件系统")
          : "存储容量检查未返回结果";
      } else if (item.type === "network") {
        const result = await runTool("network.interfaces", {});
        const network = Array.isArray(result?.network) ? result.network : [];
        const addressCount = network.reduce((sum, entry) => sum + (Array.isArray(entry.addresses) ? entry.addresses.length : 0), 0);
        if (!network.length || !addressCount) {
          status = "warning";
          findings.push("没有发现可用的非内部网络接口地址");
        }
        summary = "网络接口检查完成；接口 " + network.length + " 个，地址 " + addressCount + " 个";
      } else if (item.type === "docker") {
        const result = await runTool("fnos.docker.stats", {});
        const json = JSON.stringify(result);
        if (!json || json.length < 2) {
          status = "warning";
          findings.push("Docker 资源统计没有返回数据");
        }
        summary = "Docker 资源统计查询" + (status === "ok" ? "成功" : "需要检查") + "；不包含原始容器输出";
      } else if (item.type === "documents") {
        const result = await runTool("documents.index-status", {});
        const count = Number(result?.documentCount) || 0;
        if (!count) {
          status = "warning";
          findings.push("本地文档库目前没有已索引文档");
        }
        if (result?.partial === true) {
          status = "warning";
          findings.push("上次索引刷新是部分结果");
        }
        summary = "本地文档库检查完成；索引文档 " + count + " 个" + (result?.partial ? "；上次刷新结果不完整" : "");
      }
    } catch (error) {
      status = "error";
      // Never persist arbitrary CLI/model/exception output.
      summary = item.type === "docker"
        ? "Docker 只读状态查询失败；请检查官方 fnOS CLI 可用性和授权状态。"
        : item.type === "documents"
          ? "本地文档库状态暂不可用；请先配置应用数据目录并重试。"
          : "只读巡检失败；请检查 fnOS 查询能力是否可用。";
      if (error?.statusCode === 403) findings.push("当前执行策略不允许运行此类巡检");
    }
    const completed = clock();
    const record = {
      at: completed.toISOString(), status: safeStatus(status), summary: String(summary).slice(0, 500),
      findings: findings.slice(0, 10).map(text => text.slice(0, 160)),
      durationMs: Math.max(0, Math.min(60000, completed.getTime() - started.getTime()))
    };
    item.lastRunAt = record.at;
    item.lastStatus = record.status;
    item.lastSummary = record.summary;
    item.history = [...item.history, record].slice(-MAX_HISTORY);
    item.updatedAt = record.at;
    scheduleNext(item, completed);
    await queuePersist();
    return { check: publicCheck(item), run: record };
  }

  async function runNow(checkId) {
    await ready;
    const item = getCheck(checkId);
    if (running.has(item.id)) fail(409, "该巡检正在运行。");
    running.add(item.id);
    try { return await evaluateCheck(item); }
    finally { running.delete(item.id); }
  }

  async function runDue() {
    await ready;
    if (tickRunning) return { skipped: true, reason: "busy", ran: 0 };
    tickRunning = true;
    let ran = 0;
    try {
      const current = clock();
      for (const item of checks) {
        if (!item.enabled || running.has(item.id)) continue;
        const due = !item.nextRunAt || !Number.isFinite(Date.parse(item.nextRunAt)) || Date.parse(item.nextRunAt) <= current.getTime();
        if (!due) continue;
        running.add(item.id);
        try { await evaluateCheck(item); ran++; }
        catch { /* persistence/inspection failure is recorded by the next run; keep scheduler alive */ }
        finally { running.delete(item.id); }
      }
      return { skipped: false, ran };
    } finally { tickRunning = false; }
  }

  async function create(input) {
    await ready;
    const value = validateDefinition(input);
    if (checks.length >= MAX_CHECKS) fail(429, "定时巡检计划已达到数量上限。");
    const duplicate = checks.some(item => item.name.toLocaleLowerCase() === value.name.toLocaleLowerCase());
    if (duplicate) fail(409, "巡检计划名称已存在。");
    const createdAt = timestamp();
    const item = {
      id: id(), ...value, createdAt, updatedAt: createdAt,
      lastRunAt: null, lastStatus: null, lastSummary: "",
      nextRunAt: value.enabled ? new Date(clock().getTime() + value.intervalMinutes * 60000).toISOString() : null,
      history: []
    };
    checks.push(item);
    try { await queuePersist(); }
    catch (error) { checks = checks.filter(check => check.id !== item.id); throw error; }
    return publicCheck(item);
  }

  async function update(checkId, input = {}) {
    await ready;
    const item = getCheck(checkId);
    if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, "巡检更新参数无效。");
    if (Object.keys(input).some(key => !["name", "enabled", "intervalMinutes"].includes(key))) fail(400, "巡检更新包含不支持的字段。");
    const old = { name: item.name, enabled: item.enabled, intervalMinutes: item.intervalMinutes, nextRunAt: item.nextRunAt, updatedAt: item.updatedAt };
    if (input.name !== undefined) {
      const name = cleanName(input.name);
      if (!name) fail(400, "巡检计划名称不能为空。");
      if (checks.some(other => other.id !== item.id && other.name.toLocaleLowerCase() === name.toLocaleLowerCase())) fail(409, "巡检计划名称已存在。");
      item.name = name;
    }
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean") fail(400, "enabled 必须是布尔值。");
      item.enabled = input.enabled;
    }
    if (input.intervalMinutes !== undefined) {
      if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < MIN_INTERVAL_MINUTES || input.intervalMinutes > MAX_INTERVAL_MINUTES) fail(400, "巡检间隔必须为 5 到 10080 分钟。");
      item.intervalMinutes = input.intervalMinutes;
    }
    if (!item.enabled) item.nextRunAt = null;
    else if (!old.enabled || old.intervalMinutes !== item.intervalMinutes || !item.nextRunAt) scheduleNext(item);
    item.updatedAt = timestamp();
    try { await queuePersist(); }
    catch (error) { Object.assign(item, old); throw error; }
    return publicCheck(item);
  }

  async function remove(checkId) {
    await ready;
    const item = getCheck(checkId);
    if (running.has(item.id)) fail(409, "巡检正在运行，不能删除。");
    const before = checks;
    checks = checks.filter(check => check.id !== checkId);
    try { await queuePersist(); }
    catch (error) { checks = before; throw error; }
    return { deleted: true, id: checkId, remaining: checks.length };
  }

  const ready = load();
  function start() {
    if (timer) return false;
    timer = setIntervalFn(() => { void runDue().catch(() => {}); }, TICK_MS);
    timer?.unref?.();
    return true;
  }
  function stop() {
    if (!timer) return false;
    clearIntervalFn(timer);
    timer = null;
    return true;
  }
  return Object.freeze({ ready, list, create, update, remove, runNow, runDue, start, stop });
}

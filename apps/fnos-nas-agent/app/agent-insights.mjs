// Phase 166: the server side wiring of the observation features.
//
// The pure modules of the migration phases do not know anything about the
// process that hosts them:
//
//   - system-snapshot.mjs  scores a snapshot of six sections.
//   - diagnostics.mjs      ranks the causes of a reported symptom.
//   - security-audit.mjs   inspects the configuration and the tool catalogue.
//   - model-usage.mjs      counts the calls of the chat channel.
//
// This module connects them to the running service. It collects the raw
// numbers, it never decides what is healthy and it never mutates anything:
// every value it produces comes from a read-only source.
//
// The collector is deliberately tolerant. The official fnOS CLI does not
// promise a stable JSON shape for every command, so a missing field means
// "not collected" and never a wrong number. A section that cannot be measured
// is reported as such, it is never presented as a healthy reading.

import os from "node:os";

const MAX_TEXT_LENGTH = 100_000;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Reads the first finite number of the given keys. */
function pickNumber(source, keys) {
  if (!isObject(source)) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/** Reads the first array of the given keys. */
function pickArray(source, keys) {
  if (!isObject(source)) return null;
  for (const key of keys) {
    if (Array.isArray(source[key])) return source[key];
  }
  return null;
}

/** Reads the first boolean of the given keys. */
function pickBoolean(source, keys) {
  if (!isObject(source)) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") return value;
  }
  return null;
}

/**
 * Estimates the number of tokens of a text.
 *
 * The chat channel streams the answer and does not always report the token
 * count of the provider, so the meter works with an estimate. The estimate is
 * labelled as such in the report and never presented as an exact number.
 */
export function estimateTokens(value) {
  if (typeof value !== "string") return 0;
  const text = value.length > MAX_TEXT_LENGTH ? value.slice(0, MAX_TEXT_LENGTH) : value;
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Builds one usage record for the meter of model-usage.mjs.
 *
 * @param {object} input
 * @returns {object} a record, or null when it cannot be attributed
 */
export function buildUsageEntry({ provider, model, endpoint, outcome, promptText, completionText, latencyMs, privacyMode } = {}) {
  if (typeof provider !== "string" || !provider.trim()) return null;
  return {
    provider: provider.trim(),
    model: typeof model === "string" ? model : "",
    endpoint: typeof endpoint === "string" ? endpoint : "",
    outcome: outcome === "ok" ? "ok" : "error",
    promptTokens: estimateTokens(promptText),
    completionTokens: estimateTokens(completionText),
    latencyMs: Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : 0,
    privacyMode: privacyMode === true
  };
}

function statusTextOf(entry) {
  if (!isObject(entry)) return "";
  const status = entry.status ?? entry.state ?? entry.phase;
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}

/**
 * Creates the collector of the system snapshot.
 *
 * @param {object} options
 * @param {object|null} options.trimCli     the official CLI adapter
 * @param {object|null} options.fileManager the file manager (storage roots)
 * @param {object} [options.osModule]       the node os module (injected in tests)
 */
export function createSystemCollector({ trimCli = null, fileManager = null, osModule = os } = {}) {
  const hasCli = Boolean(trimCli && typeof trimCli.runReadOnly === "function");

  async function run(command) {
    if (!hasCli) return { ok: false, reason: "unavailable" };
    try {
      const result = await trimCli.runReadOnly(command, {});
      return { ok: true, data: result?.data ?? null };
    } catch (error) {
      return { ok: false, reason: "error", message: error?.message || "采集命令执行失败" };
    }
  }

  async function collectCpu() {
    const result = await run("monitor.cpu");
    if (!result.ok) {
      return { status: result.reason === "unavailable" ? "unavailable" : "unknown", note: "CPU 采集接口不可用" };
    }
    const data = result.data;
    const usage = pickNumber(data, ["usagePercent", "usage", "cpuUsage", "percent", "cpuPercent"]);
    const temperature = pickNumber(data, ["temperatureC", "temperature", "temp", "cpuTemperature"]);
    const values = {};
    if (usage !== null) values.usagePercent = usage;
    if (temperature !== null) values.temperatureC = temperature;
    const cores = pickNumber(data, ["cores", "logicalCores", "cpuCount"]);
    if (cores !== null) values.cores = cores;
    if (!Object.keys(values).length) return { status: "unknown", note: "CPU 采集接口未返回可用数据" };
    return { status: "ok", values };
  }

  async function collectMemory() {
    const result = await run("monitor.memory");
    if (!result.ok) {
      // The node process itself always knows its own memory, so the section is
      // never empty even without the official CLI.
      const total = osModule.totalmem?.();
      const free = osModule.freemem?.();
      if (typeof total === "number" && typeof free === "number" && total > 0) {
        return {
          status: "ok",
          values: { totalBytes: total, availableBytes: free, usedPercent: Math.round(((total - free) / total) * 100) },
          note: "数据来自本机进程，未使用官方 CLI"
        };
      }
      return { status: result.reason === "unavailable" ? "unavailable" : "unknown", note: "内存采集接口不可用" };
    }
    const data = result.data;
    const total = pickNumber(data, ["totalBytes", "total", "sizeBytes"]);
    const available = pickNumber(data, ["availableBytes", "available", "freeBytes", "free"]);
    const used = pickNumber(data, ["usedBytes", "used"]);
    const percent = pickNumber(data, ["usedPercent", "usagePercent", "percent", "usage"]);
    const values = {};
    if (total !== null) values.totalBytes = total;
    if (available !== null) values.availableBytes = available;
    if (used !== null) values.usedBytes = used;
    if (percent !== null) values.usedPercent = percent;
    else if (total !== null && used !== null && total > 0) values.usedPercent = Math.round((used / total) * 100);
    if (!Object.keys(values).length) return { status: "unknown", note: "内存采集接口未返回可用数据" };
    return { status: "ok", values };
  }

  async function collectStorage() {
    const result = await run("monitor.disk");
    const disks = [];
    if (result.ok) {
      const list = pickArray(result.data, ["disks", "devices", "items", "volumes"]);
      for (const item of Array.isArray(list) ? list : []) {
        if (!isObject(item)) continue;
        const name = item.name ?? item.device ?? item.mount ?? item.path ?? "磁盘";
        const total = pickNumber(item, ["totalBytes", "total", "sizeBytes", "size"]);
        const used = pickNumber(item, ["usedBytes", "used", "usageBytes"]);
        const entry = { name: String(name) };
        if (total !== null) entry.totalBytes = total;
        if (used !== null) entry.usedBytes = used;
        const smart = item.smart;
        if (isObject(smart)) entry.smart = { supported: smart.supported === true, status: typeof smart.status === "string" ? smart.status : "unknown" };
        disks.push(entry);
      }
    }
    if (!disks.length && fileManager && typeof fileManager.getRoots === "function") {
      try {
        for (const root of await fileManager.getRoots()) {
          disks.push({ name: String(root), totalBytes: null, usedBytes: null });
        }
      } catch { /* the roots are optional */ }
    }
    if (!disks.length) return { status: "unknown", note: "存储采集接口未返回可用数据" };
    return { status: "ok", values: { disks } };
  }

  async function collectNetwork() {
    const result = await run("monitor.net");
    if (result.ok) {
      const data = result.data;
      const online = pickBoolean(data, ["online", "connected", "up"]);
      const latency = pickNumber(data, ["latencyMs", "latency", "ping", "pingMs"]);
      const values = {};
      if (online !== null) values.online = online;
      else values.online = true;
      if (latency !== null) values.latencyMs = latency;
      return { status: "ok", values };
    }
    const interfaces = typeof osModule.networkInterfaces === "function" ? osModule.networkInterfaces() : {};
    const names = Object.keys(interfaces || {});
    if (!names.length) return { status: "unknown", note: "网络采集接口未返回可用数据" };
    return { status: "ok", values: { online: true }, note: "数据来自本机网络接口，未使用官方 CLI" };
  }

  async function collectServices() {
    const result = await run("app.list");
    if (!result.ok) return { status: "unknown", note: "服务采集接口不可用" };
    const list = pickArray(result.data, ["apps", "services", "items"]);
    if (!list) return { status: "unknown", note: "服务采集接口未返回可用数据" };
    const failed = list.filter(item => ["error", "failed", "unhealthy", "stopped"].includes(statusTextOf(item))).length;
    return { status: "ok", values: { total: list.length, failed } };
  }

  async function collectDocker() {
    const result = await run("docker.container.ls-all");
    if (!result.ok) return { status: "unknown", note: "容器采集接口不可用" };
    const list = pickArray(result.data, ["containers", "items"]);
    if (!list) return { status: "unknown", note: "容器采集接口未返回可用数据" };
    const running = list.filter(item => ["running", "up"].includes(statusTextOf(item))).length;
    return { status: "ok", values: { containersTotal: list.length, containersRunning: running, available: true } };
  }

  const COLLECTORS = {
    cpu: collectCpu,
    memory: collectMemory,
    storage: collectStorage,
    network: collectNetwork,
    services: collectServices,
    docker: collectDocker
  };

  return {
    async collect(sectionId) {
      const collector = COLLECTORS[sectionId];
      if (!collector) return { status: "unknown", note: "未知采集分区" };
      try {
        return await collector();
      } catch (error) {
        return { status: "unavailable", note: error?.message || "采集失败" };
      }
    }
  };
}

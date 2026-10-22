/**
 * 容量历史：把每次读到的磁盘用量落成一条采样，供 capacity-forecast.mjs 计算趋势。
 *
 * 为什么需要它：趋势预测的输入是「时间序列」，而系统快照只是一次测量。没有历史
 * 就没有趋势，这个模块只做一件事——把测量按时间排队、去重、封顶、原子落盘。
 *
 * 设计约束：
 * - 只读采样，不碰任何被监控的文件；写入只发生在自己的 dataDir 里。
 * - 同一小时的重复读取不记新点（minIntervalMs），避免刷新页面把序列刷成锯齿。
 * - 记录条数封顶（默认 720），超出丢最旧；文件损坏时按空历史处理，绝不让
 *   一次坏文件拖垮接口。
 * - 写入走「临时文件 + rename」，读者永远看不到半个 JSON。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const HISTORY_FILE_NAME = "capacity-history.json";
export const HISTORY_VERSION = 1;
export const DEFAULT_MAX_RECORDS = 720;
export const DEFAULT_MIN_INTERVAL_MS = 60 * 60 * 1000;

const DEFAULT_FS = Object.freeze({
  existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync
});

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 清洗一条采样：只留 name / totalBytes / usedBytes，非法碟片整条丢弃。 */
export function normalizeRecord(input) {
  if (!isObject(input)) return null;
  const at = typeof input.at === "string" && !Number.isNaN(Date.parse(input.at)) ? input.at : null;
  if (!at) return null;
  const disks = [];
  for (const disk of Array.isArray(input.disks) ? input.disks : []) {
    if (!isObject(disk)) continue;
    const name = typeof disk.name === "string" ? disk.name.trim().slice(0, 120) : "";
    if (!name) continue;
    const totalBytes = toNumberOrNull(disk.totalBytes);
    const usedBytes = toNumberOrNull(disk.usedBytes);
    if (totalBytes === null && usedBytes === null) continue;
    disks.push({ name, totalBytes, usedBytes });
  }
  if (!disks.length) return null;
  return { at, disks };
}

/**
 * @param {object} [options]
 * @param {string} [options.dataDir] 为空时不落盘（read 返回空历史，append 返回 no-data-dir）。
 * @param {() => Date} [options.now]
 * @param {number} [options.maxRecords]
 * @param {number} [options.minIntervalMs] 两条采样之间的最小间隔，默认 1 小时。
 * @param {object} [options.fs] 注入点（测试用）。
 */
export function createCapacityHistory({ dataDir = "", now = () => new Date(), maxRecords = DEFAULT_MAX_RECORDS, minIntervalMs = DEFAULT_MIN_INTERVAL_MS, fs = DEFAULT_FS } = {}) {
  const filePath = dataDir ? join(dataDir, HISTORY_FILE_NAME) : "";
  const cap = Number.isSafeInteger(maxRecords) && maxRecords > 0 ? maxRecords : DEFAULT_MAX_RECORDS;
  const interval = Number.isSafeInteger(minIntervalMs) && minIntervalMs >= 0 ? minIntervalMs : DEFAULT_MIN_INTERVAL_MS;

  function read() {
    if (!filePath || !fs.existsSync(filePath)) return { records: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const list = Array.isArray(parsed?.records) ? parsed.records : [];
      const records = [];
      for (const item of list) {
        const record = normalizeRecord(item);
        if (record) records.push(record);
      }
      return { records };
    } catch {
      // 损坏或半截写入：当作没有历史，下一次 append 会重建。
      return { records: [] };
    }
  }

  function write(records) {
    if (!filePath) return false;
    try {
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const tempPath = `${filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ version: HISTORY_VERSION, records }), "utf8");
      fs.renameSync(tempPath, filePath);
      return true;
    } catch {
      try {
        fs.unlinkSync(`${filePath}.tmp`);
      } catch { /* 临时文件可能不存在 */ }
      return false;
    }
  }

  function append(input) {
    const record = normalizeRecord(input);
    if (!record) return { appended: false, reason: "invalid-record", records: read().records };
    if (!filePath) return { appended: false, reason: "no-data-dir", records: [] };
    const { records } = read();
    const last = records[records.length - 1];
    if (last) {
      const gap = Date.parse(record.at) - Date.parse(last.at);
      if (gap >= 0 && gap < interval) return { appended: false, reason: "recent-sample", records };
      if (gap < 0) return { appended: false, reason: "out-of-order", records };
    }
    const next = records.concat([record]).slice(-cap);
    if (!write(next)) return { appended: false, reason: "write-failed", records };
    return { appended: true, reason: null, records: next };
  }

  return { read, append, filePath: () => filePath, now };
}

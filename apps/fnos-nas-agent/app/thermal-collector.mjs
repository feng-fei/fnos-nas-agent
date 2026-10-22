/**
 * 温度采集器：只读 /sys/class/thermal 下的 zone 文件。
 *
 * 这一层只负责「把原始读数取出来」，判定交给 thermal-status.mjs：
 * 取值失败就跳过该 zone 并留痕，绝不补一个 0℃；根目录读不到就抛错，
 * 由路由把整段报成 unknown。
 *
 * 安全边界：只读固定目录下的 thermal_zoneN 子目录，不读用户路径，
 * 不开写句柄，最多 32 个 zone，标签截断到 60 字符。
 */

import { readdirSync, readFileSync } from "node:fs";

export const THERMAL_ROOT = "/sys/class/thermal";
export const MAX_THERMAL_ZONES = 32;
export const MAX_LABEL_LENGTH = 60;

const ZONE_PATTERN = /^thermal_zone\d+$/;

function sortZones(names) {
  return names
    .filter((name) => typeof name === "string" && ZONE_PATTERN.test(name))
    .sort((left, right) => Number(left.slice("thermal_zone".length)) - Number(right.slice("thermal_zone".length)));
}

/**
 * @param {object} [options]
 * @param {string} [options.root] 默认 /sys/class/thermal。
 * @param {(path: string) => string[]} [options.readDir] 注入点（测试用）。
 * @param {(path: string) => string} [options.readFile] 注入点（测试用）。
 * @returns {() => {readings: Array<{source: string, label: string, raw: string, unit: "milliCelsius"}>, notes: string[]}}
 */
export function createThermalCollector({ root = THERMAL_ROOT, readDir = readdirSync, readFile = (path) => readFileSync(path, "utf8") } = {}) {
  if (typeof readDir !== "function" || typeof readFile !== "function") {
    throw new TypeError("createThermalCollector() requires readDir and readFile functions");
  }
  return function collectThermalZones() {
    const zones = sortZones(readDir(root));
    const readings = [];
    const notes = [];
    for (const zone of zones.slice(0, MAX_THERMAL_ZONES)) {
      const base = `${root}/${zone}`;
      let raw;
      try {
        raw = String(readFile(`${base}/temp`) ?? "").trim();
      } catch {
        notes.push(`temp-unreadable:${zone}`);
        continue;
      }
      if (!raw) {
        notes.push(`temp-empty:${zone}`);
        continue;
      }
      let label = zone;
      try {
        const type = String(readFile(`${base}/type`) ?? "").trim();
        if (type) label = type.slice(0, MAX_LABEL_LENGTH);
      } catch {
        // type 不是必需的：没有它就用 zone 名当标签。
      }
      readings.push({ source: zone, label, raw, unit: "milliCelsius" });
    }
    if (zones.length > MAX_THERMAL_ZONES) notes.push(`zones-capped:${MAX_THERMAL_ZONES}`);
    if (!readings.length) notes.push("no-thermal-zone");
    return { readings, notes };
  };
}

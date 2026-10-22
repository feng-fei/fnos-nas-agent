/**
 * SMART 采集器：调用 smartctl 读取固定白名单磁盘的识别信息与属性表。
 *
 * 设计取舍：
 * - smartctl 通常需要 root/CAP_SYS_RAWIO。商店版应用拿不到这些权限，所以本采集器
 *   **默认不启用**，需要显式 `FNOS_AGENT_SMART_COLLECTOR=on`；启用后仍然只读
 *   （`-H -A`，不带 `-t`/`-o` 这类会改盘状态的参数）。
 * - 设备名来自 `/sys/block` 的白名单正则，不来自请求；最多 8 块盘。
 * - 任何一块盘失败只留痕，不影响其它盘；全部失败由路由报 unknown。
 */

import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { promisify } from "node:util";

export const SMART_COMMAND = "smartctl";
export const SMART_ARGS = Object.freeze(["-H", "-A"]);
export const SMART_DEVICE_ROOT = "/sys/block";
export const MAX_SMART_DEVICES = 8;
export const SMART_TIMEOUT_MS = 8000;
export const SMART_MAX_OUTPUT_BYTES = 64 * 1024;
export const SMART_DEVICE_PATTERN = /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|hd[a-z]+)$/u;

/**
 * @param {object} [options]
 * @param {(file: string, args: string[], options?: object) => Promise<{stdout?: string}>} [options.exec]
 * @param {(path: string) => string[]} [options.readDir]
 * @param {string} [options.root]
 * @param {string} [options.command]
 * @param {boolean} [options.capDevices] 是否把单次盘数上限用于结果（测试可关）。
 * @returns {() => Promise<{devices: Array<{device: string, text: string}>, notes: string[]}>}
 */
export function createSmartctlCollector({
  exec = promisify(execFile),
  readDir = readdirSync,
  root = SMART_DEVICE_ROOT,
  command = SMART_COMMAND,
  capDevices = true
} = {}) {
  if (typeof exec !== "function" || typeof readDir !== "function") {
    throw new TypeError("createSmartctlCollector() requires exec and readDir functions");
  }
  return async function collectSmartHealth() {
    const names = readDir(root)
      .filter((name) => typeof name === "string" && SMART_DEVICE_PATTERN.test(name))
      .sort();
    const selected = capDevices ? names.slice(0, MAX_SMART_DEVICES) : names;
    const devices = [];
    const notes = [];
    if (names.length > selected.length) notes.push(`devices-capped:${MAX_SMART_DEVICES}`);
    for (const name of selected) {
      const path = `/dev/${name}`;
      try {
        const result = await exec(command, [...SMART_ARGS, path], {
          timeout: SMART_TIMEOUT_MS,
          maxBuffer: SMART_MAX_OUTPUT_BYTES,
          windowsHide: true
        });
        devices.push({ device: path, text: String(result?.stdout ?? "") });
      } catch (error) {
        // smartctl 对「不支持 SMART」的盘会返回非零退出码，但 stdout 仍是有效信息
        // （`SMART support is: Unavailable`）。这种情况下继续解析，让判定层说
        // unavailable，而不是在这里先判死。
        const stdout = typeof error?.stdout === "string" ? error.stdout : "";
        if (stdout.trim()) {
          devices.push({ device: path, text: stdout });
          notes.push(`smart-nonzero-exit:${name}`);
          continue;
        }
        const code = error?.code ?? error?.signal ?? "error";
        notes.push(`smart-failed:${name}:${String(code).slice(0, 40)}`);
      }
    }
    if (!devices.length) notes.push("no-smart-device");
    return { devices, notes };
  };
}

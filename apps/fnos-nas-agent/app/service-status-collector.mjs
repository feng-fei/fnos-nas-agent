/**
 * 采集器：把 `systemctl show` 的原始输出交给 service-status.mjs 解析。
 *
 * 分工是刻意的：service-status.mjs 负责「校验 + 解析 + 结论」，本文件只负责
 * 「以固定 argv 调起一次只读命令」。这样解析逻辑可以完全离线测试，而唯一
 * 会碰系统的地方被压缩到 20 行以内，容易被审阅。
 *
 * 安全边界：
 * - 不加 shell：execFile 直接 execve，unit 名不会被解释成命令片段。
 * - argv 固定：只允许 `systemctl show <unit> -p <固定属性表>`，没有第二个子命令。
 * - unit 先过 validateUnitName()，非法名在调起前就抛错，绝不下发。
 * - 超时与输出上限都很小：只读一次状态，读不到就按失败上报，不重试。
 */

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { validateUnitName } from "./service-status.mjs";

const execFile = promisify(execFileCallback);

/** 只问这几个属性，多一个都不问。 */
export const SYSTEMCTL_PROPERTIES = Object.freeze([
  "LoadState",
  "ActiveState",
  "SubState",
  "UnitFileState",
  "MainPID",
  "MemoryCurrent",
  "NRestarts",
  "Result"
]);

/**
 * fnOS 1.2 上实测存在的核心服务（2026-10-24 在 172.28.10.2 上 `systemctl
 * list-units` 抄下来的，非虚构）。默认只看这 12 个：都是文件服务、网络、
 * 存储监控这类「停了就该知道」的守护进程。
 *
 * 这不是权威名单——升级后 unit 可能改名或消失。名字失效时采集结果是
 * unknown + `[not set]`，不会被误报成健康；要改名单就改这里。
 */
export const FNOS_SERVICE_UNITS = Object.freeze([
  "filestor_service.service",
  "network_service.service",
  "trim_file_monitor.service",
  "mediasrv.service",
  "imagesrv.service",
  "accountsrv.service",
  "dlcenter.service",
  "backup_service.service",
  "finder_service.service",
  "docker.service",
  "appcenter.service",
  "smbd.service"
]);

export const DEFAULT_TIMEOUT_MS = 4000;
export const MAX_OUTPUT_BYTES = 16 * 1024;

/**
 * @param {object} [options]
 * @param {Function} [options.execFile] 注入点（测试用），签名同 promisify(execFile)。
 * @param {string} [options.command] 默认 `systemctl`。
 * @param {number} [options.timeoutMs] 单条超时。
 * @returns {(unit: string) => Promise<string>} 交给 collectServiceStatus({ run }) 的采集器。
 */
export function createSystemctlCollector({ execFile: run = execFile, command = "systemctl", timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof run !== "function") throw new TypeError("createSystemctlCollector() requires execFile to be a function");
  const timeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  return async function collectUnitStatus(unit) {
    const validation = validateUnitName(unit);
    if (!validation.ok) {
      throw new Error(`invalid-unit: ${validation.reason}`);
    }
    const args = ["show", unit];
    for (const property of SYSTEMCTL_PROPERTIES) {
      args.push("-p", property);
    }
    const { stdout } = await run(command, args, { timeout, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true });
    return String(stdout ?? "");
  };
}

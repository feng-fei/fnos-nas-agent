import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { parseStatsLine } from "./docker-stats.mjs";

// Phase 204 的采集器：`docker stats --no-stream` 只取一次快照。
//
// 它单独成模块而不是留在 server.mjs 里，是因为仓库有一条架构不变量：
// server.mjs 只做组合，不直接起子进程（scripts/check-release-gates.mjs 会拦）。
// execFile 可注入，测试因此不需要真的有 Docker。
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

export const DOCKER_STATS_COMMAND = Object.freeze({
  file: "docker",
  args: Object.freeze(["stats", "--no-stream", "--format", "{{json .}}"])
});

export function createDockerStatsCollector(options = {}) {
  const settings = options && typeof options === "object" ? options : {};
  const execFile = typeof settings.execFile === "function"
    ? settings.execFile
    : promisify(execFileCallback);
  const timeoutMs = Number.isInteger(settings.timeoutMs) && settings.timeoutMs > 0
    ? settings.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const maxBufferBytes = Number.isInteger(settings.maxBufferBytes) && settings.maxBufferBytes > 0
    ? settings.maxBufferBytes
    : DEFAULT_MAX_BUFFER_BYTES;
  const now = typeof settings.now === "function" ? settings.now : () => new Date().toISOString();

  return async function collectDockerStats() {
    const { stdout } = await execFile(DOCKER_STATS_COMMAND.file, [...DOCKER_STATS_COMMAND.args], {
      timeout: timeoutMs,
      maxBuffer: maxBufferBytes
    });
    const samples = [];
    const dropped = [];
    for (const line of String(stdout ?? "").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = parseStatsLine(line);
      if (parsed.ok === true) samples.push(parsed.container);
      // 解析不了的行只留原因与一小段预览，不把整行原样带出去。
      else dropped.push({ reason: parsed.reason, preview: line.slice(0, 80) });
    }
    return { collectedAt: now(), samples, dropped };
  };
}

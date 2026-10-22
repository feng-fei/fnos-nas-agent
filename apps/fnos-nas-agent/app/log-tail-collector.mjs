/**
 * 日志尾部采集器：从只读日志文件里取最后 N 字节文本，交给 system-events.mjs 解析。
 *
 * 只读、只取尾部：日志文件可能很大，整份读进来既慢又没必要；尾部恰好是最近的
 * 事件。路径是固定白名单，不来自请求；打不开的文件跳过并在 notes 留痕，最终
 * 一条都没读到时返回空文本，由路由把整段报成 unknown，而不是「没有错误」。
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

export const DEFAULT_LOG_PATHS = Object.freeze(["/var/log/syslog", "/var/log/messages", "/var/log/kern.log"]);
export const MAX_LOG_BYTES = 64 * 1024;

/**
 * @param {object} [options]
 * @param {readonly string[]} [options.paths] 固定白名单。
 * @param {number} [options.maxBytes] 单文件尾部上限。
 * @param {object} [options.fs] 注入点（stat/open/read/close），测试用。
 * @returns {() => {text: string, notes: string[], sources: string[]}}
 */
export function createLogTailCollector({ paths = DEFAULT_LOG_PATHS, maxBytes = MAX_LOG_BYTES, fs = null } = {}) {
  const stat = fs?.statSync ?? statSync;
  const open = fs?.openSync ?? openSync;
  const read = fs?.readSync ?? readSync;
  const close = fs?.closeSync ?? closeSync;
  const cap = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : MAX_LOG_BYTES;
  const whitelist = (Array.isArray(paths) ? paths : []).filter((item) => typeof item === "string" && item.startsWith("/"));

  return function collectLogTail() {
    const chunks = [];
    const notes = [];
    const sources = [];
    for (const path of whitelist) {
      let size;
      try {
        const info = stat(path);
        if (!info || typeof info.isFile === "function" && !info.isFile()) {
          notes.push(`not-a-file:${path}`);
          continue;
        }
        size = Number(info.size);
      } catch {
        notes.push(`unreadable:${path}`);
        continue;
      }
      if (!Number.isFinite(size) || size <= 0) {
        notes.push(`empty:${path}`);
        continue;
      }
      const length = Math.min(size, cap);
      let fd;
      try {
        fd = open(path, "r");
        const buffer = Buffer.alloc(length);
        const bytes = read(fd, buffer, 0, length, Math.max(0, size - length));
        if (!bytes) {
          notes.push(`short-read:${path}`);
          continue;
        }
        chunks.push(buffer.subarray(0, bytes).toString("utf8"));
        sources.push(path);
      } catch {
        notes.push(`unreadable:${path}`);
      } finally {
        if (fd !== undefined) {
          try {
            close(fd);
          } catch {
            // fd 关不掉不影响已经读到的内容。
          }
        }
      }
    }
    return { text: chunks.join("\n"), notes, sources };
  };
}

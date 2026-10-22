import { detectDuplicates } from "./duplicate-detector.mjs";

/**
 * 「当前目录重复文件扫描」的编排层。
 *
 * 把文件浏览器（列目录）与文件管理器（算哈希）适配成 duplicate-detector 需要的两个
 * 回调，并统一约束：只扫描单层目录、只对同大小的候选文件算哈希、超大文件跳过哈希。
 *
 * 这样 server 的 HTTP 路由只负责鉴权/限流/参数校验，扫描语义可以脱离文件系统单测。
 *
 * @param {object} options
 * @param {(dir: string, limit: number) => Promise<Array<{path: string, size: number}>>} options.listEntries
 * @param {(path: string) => Promise<string>} options.readHash
 */
export function createDuplicateScanner({ listEntries, readHash } = {}) {
  if (typeof listEntries !== "function") throw new TypeError("listEntries must be a function");
  if (typeof readHash !== "function") throw new TypeError("readHash must be a function");

  /**
   * @param {object} [options]
   * @param {string} [options.dir=""] 扫描目录（空串表示根目录）
   * @param {number} [options.limit=200] 最多参与分析的文件数
   * @param {number} [options.maxHashBytes=67108864] 超过该字节数只按大小分组
   */
  async function scan({ dir = "", limit = 200, maxHashBytes = 64 * 1024 * 1024 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw Object.assign(new TypeError("limit must be between 1 and 500"), { statusCode: 400 });
    }
    const listed = await listEntries(dir, limit);
    const candidates = (Array.isArray(listed) ? listed : [])
      .filter((entry) => entry && typeof entry.path === "string" && entry.path.trim() !== "")
      .filter((entry) => Number.isFinite(entry.size) && entry.size > 0)
      .slice(0, limit)
      .map((entry) => ({ path: entry.path, size: entry.size }));

    const note = "只比较当前目录下的文件，不递归子目录；超过 64MiB 的文件只按大小分组、不做哈希。";
    if (candidates.length === 0) {
      return { dir, listed: 0, truncated: false, scanned: 0, candidates: 0, groups: [], skipped: [], note };
    }

    const report = await detectDuplicates({
      dir,
      limit: candidates.length,
      listEntries: async () => candidates,
      readHash,
      maxHashBytes
    });

    return {
      dir,
      listed: candidates.length,
      truncated: Boolean(report.truncated),
      scanned: report.scanned,
      candidates: report.candidates,
      groups: report.groups,
      skipped: report.skipped.slice(0, 20),
      note
    };
  }

  return { scan };
}

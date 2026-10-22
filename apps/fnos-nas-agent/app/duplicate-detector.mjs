/**
 * Phase 163 — 重复文件检测与归档候选（模块 04 · 智能文件管理与搜索）
 *
 * 本模块是**纯逻辑 + 注入式文件系统访问**的只读分析器：
 *
 * - 不 import node:fs，不做任何文件读写、移动、删除；
 * - 文件系统能力由调用方以函数注入（listEntries / readHash）；
 * - 自动归档只产出**只读计划**（planArchive），永不自行移动或删除文件。
 *
 * 覆盖用户功能清单：F07（重复文件检测）、F08（临时文件识别，仅出计划）、
 * F09（自动归档，仅出计划）、F11（整理预览）、F24（索引管理状态展示）。
 */

const DEFAULT_LIMIT = 2000;
const DEFAULT_MAX_HASH_BYTES = 64 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DETAIL_LENGTH = 200;

/** 扩展名归一：小写、带点，例如 "TMP" → ".tmp"。 */
function normalizeExtension(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

/** 取路径的文件名，兼容 POSIX 与 Windows 分隔符。 */
function baseName(path) {
  const text = String(path ?? "");
  const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return cut >= 0 ? text.slice(cut + 1) : text;
}

/** 取路径所在目录，兼容 POSIX 与 Windows 分隔符。 */
function dirName(path) {
  const text = String(path ?? "");
  const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return cut >= 0 ? text.slice(0, cut) : "";
}

/** NAS 风格的路径拼接，永远使用 "/"。 */
function joinPath(target, name) {
  const left = String(target ?? "").replace(/[\\/]+$/, "");
  const right = String(name ?? "").replace(/^[\\/]+/, "");
  if (left === "") return right;
  if (right === "") return left;
  return `${left}/${right}`;
}

/** 目录是否相同（忽略尾部斜杠与大小写差异之外的字符）。 */
function sameDirectory(left, right) {
  const a = String(left ?? "").replace(/[\\/]+$/, "");
  const b = String(right ?? "").replace(/[\\/]+$/, "");
  if (a === "" || b === "") return false;
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/** 文件扩展名（含点，小写），无扩展名返回 ""。 */
function extensionOf(path) {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot).toLowerCase();
}

/** 把 glob 片段转成正则；不含 * / ? 时按子串匹配。 */
function nameMatches(name, pattern) {
  const text = String(name ?? "");
  const raw = String(pattern ?? "");
  if (raw === "") return false;
  if (!raw.includes("*") && !raw.includes("?")) {
    return text.toLowerCase().includes(raw.toLowerCase());
  }
  const escaped = raw.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern2 = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  try {
    return new RegExp(`^${pattern2}$`, "i").test(text);
  } catch {
    return false;
  }
}

/** 错误摘要：只取 message 并截断，避免把堆栈或整页内容带进结果。 */
function describeError(error) {
  if (!error) return "unknown error";
  const message = typeof error?.message === "string" ? error.message : String(error);
  const flat = message.replace(/\s+/g, " ").trim();
  if (flat === "") return "unknown error";
  return flat.length > MAX_DETAIL_LENGTH ? `${flat.slice(0, MAX_DETAIL_LENGTH)}…` : flat;
}

/**
 * 按大小给条目分组。
 *
 * @param {Array<{path: string, size: number, mtimeMs?: number}>} entries
 * @returns {Array<{size: number, paths: string[]}>} 只含出现次数 ≥ 2 的分组，按 size 升序
 */
export function groupBySize(entries) {
  if (!Array.isArray(entries)) return [];
  const buckets = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || entry.path.trim() === "") continue;
    if (!Number.isFinite(entry.size) || entry.size < 0) continue;
    if (!buckets.has(entry.size)) buckets.set(entry.size, new Set());
    buckets.get(entry.size).add(entry.path);
  }
  return [...buckets.entries()]
    .filter(([, paths]) => paths.size >= 2)
    .sort((a, b) => a[0] - b[0])
    .map(([size, paths]) => ({ size, paths: [...paths].sort() }));
}

/**
 * 两阶段重复文件检测：先按大小分组，只对同大小组计算哈希，哈希一致才算重复。
 *
 * @param {object} options
 * @param {(dir: string) => Promise<Array<{path: string, size: number, mtimeMs?: number}>>} options.listEntries
 * @param {(path: string, size: number) => Promise<string>} options.readHash
 * @param {number} [options.limit=2000] 最多分析多少个条目，超出即 truncated
 * @param {number} [options.maxHashBytes=67108864] 超过该字节数不计算哈希
 * @param {string} [options.dir="."] 传给 listEntries 的扫描目录
 */
export async function detectDuplicates({
  listEntries,
  readHash,
  limit = DEFAULT_LIMIT,
  maxHashBytes = DEFAULT_MAX_HASH_BYTES,
  dir = "."
} = {}) {
  if (typeof listEntries !== "function") throw new TypeError("listEntries must be a function");
  if (typeof readHash !== "function") throw new TypeError("readHash must be a function");
  if (!Number.isInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive integer");
  if (!Number.isFinite(maxHashBytes) || maxHashBytes < 0) {
    throw new TypeError("maxHashBytes must be a non-negative number");
  }

  const skipped = [];
  const empty = { scanned: 0, candidates: 0, groups: [], truncated: false, skipped };

  let listed;
  try {
    listed = await listEntries(dir);
  } catch (error) {
    skipped.push({ path: String(dir), reason: "list-failed", detail: describeError(error) });
    return empty;
  }
  if (!Array.isArray(listed)) {
    skipped.push({ path: String(dir), reason: "invalid-list" });
    return empty;
  }

  const valid = [];
  for (const entry of listed) {
    const path = entry && typeof entry.path === "string" ? entry.path : "";
    if (path.trim() === "" || !Number.isFinite(entry?.size) || entry.size < 0) {
      skipped.push({ path, reason: "invalid-entry" });
      continue;
    }
    valid.push(entry);
  }

  let truncated = false;
  let scanned = 0;
  const considered = [];
  for (const entry of valid) {
    if (scanned >= limit) {
      truncated = true;
      break;
    }
    scanned += 1;
    considered.push(entry);
  }

  const sizeGroups = groupBySize(considered);
  let candidates = 0;
  for (const group of sizeGroups) candidates += group.paths.length;

  const groups = [];
  for (const group of sizeGroups) {
    const byHash = new Map();
    for (const path of group.paths) {
      if (group.size > maxHashBytes) {
        skipped.push({ path, reason: "too-large" });
        continue;
      }
      let hash;
      try {
        hash = await readHash(path, group.size);
      } catch (error) {
        skipped.push({ path, reason: "hash-failed", detail: describeError(error) });
        continue;
      }
      if (typeof hash !== "string" || hash.trim() === "") {
        skipped.push({ path, reason: "invalid-hash" });
        continue;
      }
      const key = hash.trim().toLowerCase();
      if (!byHash.has(key)) byHash.set(key, []);
      byHash.get(key).push(path);
    }
    for (const [hash, paths] of byHash) {
      if (paths.length < 2) continue;
      const sorted = [...paths].sort();
      groups.push({
        size: group.size,
        hash,
        paths: sorted,
        wastedBytes: group.size * (sorted.length - 1)
      });
    }
  }
  groups.sort((a, b) => a.size - b.size || a.hash.localeCompare(b.hash));

  return { scanned, candidates, groups, truncated, skipped };
}

/** 单条规则是否命中一个条目（所有已给定的条件都必须满足）。 */
function ruleMatches(rule, entry, nowMs) {
  if (!rule || typeof rule !== "object") return false;
  if (typeof rule.target !== "string" || rule.target.trim() === "") return false;
  const match = rule.match && typeof rule.match === "object" ? rule.match : {};
  const checks = [];

  if (Array.isArray(match.ext) && match.ext.length > 0) {
    const wanted = match.ext.map(normalizeExtension).filter(value => value !== "");
    const actual = extensionOf(entry.path);
    checks.push(wanted.includes(actual));
  }
  if (typeof match.namePattern === "string" && match.namePattern !== "") {
    checks.push(nameMatches(baseName(entry.path), match.namePattern));
  }
  if (Number.isFinite(match.olderThanDays)) {
    const mtime = Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : Number.NaN;
    checks.push(Number.isFinite(mtime) && mtime <= nowMs - match.olderThanDays * DAY_MS);
  }
  if (Number.isFinite(match.minSizeBytes)) {
    checks.push(Number.isFinite(entry.size) && entry.size >= match.minSizeBytes);
  }

  if (checks.length === 0) return false;
  return checks.every(value => value === true);
}

/**
 * 自动归档候选的**只读计划**：只计算要移动什么、移动到哪里、为什么，绝不移动文件。
 *
 * @param {Array<{path: string, size: number, mtimeMs?: number}>} entries
 * @param {object} [options]
 * @param {Array<{id: string, match?: object, target: string}>} [options.rules]
 * @param {boolean} [options.dryRun=true] 计划标记；无论取值，本函数都不做任何文件操作
 * @param {number} [options.now=Date.now()] 判定 olderThanDays 的时间基准
 */
export function planArchive(entries, { rules = [], dryRun = true, now = Date.now() } = {}) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  if (!Array.isArray(rules)) throw new TypeError("rules must be an array");

  const moves = [];
  const skipped = [];
  const nowMs = Number.isFinite(now) ? now : Date.now();
  let freedBytes = 0;

  for (const entry of entries) {
    const path = entry && typeof entry.path === "string" ? entry.path : "";
    if (path.trim() === "") {
      skipped.push({ path, reason: "invalid-entry" });
      continue;
    }
    const size = Number.isFinite(entry?.size) ? Math.max(0, entry.size) : 0;
    const rule = rules.find(candidate => ruleMatches(candidate, entry, nowMs));
    if (!rule) {
      skipped.push({ path, reason: "no-matching-rule" });
      continue;
    }
    if (sameDirectory(dirName(path), rule.target)) {
      skipped.push({ path, reason: "already-in-target" });
      continue;
    }
    moves.push({
      from: path,
      to: joinPath(rule.target, baseName(path)),
      reason: `rule:${String(rule.id ?? "unnamed")}`
    });
    freedBytes += size;
  }

  return { moves, skipped, freedBytes, dryRun: dryRun !== false };
}

/** 时间戳归一为 ISO 字符串；无法解析时返回 null。 */
function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return null;
    return new Date(parsed).toISOString();
  }
  return null;
}

/**
 * 索引状态描述（供 F24 索引管理展示）。
 *
 * @param {object} [options]
 * @param {number} [options.indexedPaths=0]
 * @param {string[]} [options.excludedPaths=[]]
 * @param {string|number|null} [options.lastUpdatedAt=null]
 * @param {boolean} [options.dirty=false]
 */
export function describeIndexState({
  indexedPaths = 0,
  excludedPaths = [],
  lastUpdatedAt = null,
  dirty = false
} = {}) {
  const count = Number.isFinite(indexedPaths) ? Math.max(0, Math.trunc(indexedPaths)) : 0;
  const excluded = Array.isArray(excludedPaths) ? excludedPaths.length : 0;
  const updated = normalizeTimestamp(lastUpdatedAt);
  const isDirty = dirty === true;

  let status = "ok";
  if (isDirty) status = "stale";
  else if (!updated) status = "unknown";

  return { status, indexedPaths: count, excludedCount: excluded, lastUpdatedAt: updated, dirty: isDirty };
}

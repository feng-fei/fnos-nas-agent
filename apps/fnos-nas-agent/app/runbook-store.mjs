/**
 * Phase 169: the runbook library.
 *
 * The repository had a documentation index, but the agent had no place where a
 * known procedure could be looked up and reused. A runbook is that place: a
 * short, addressed note with a title, optional tags, a body and a source.
 *
 * The rules this module keeps:
 *   - An entry is addressed by a strict id. There is no second way to reach
 *     an entry, so an agent cannot guess its way into a foreign namespace.
 *   - A write never overwrites silently. An existing id is refused and the
 *     caller receives the reason, so a mistake stays visible.
 *   - The body of an entry never carries a credential. A value that looks like
 *     a key or a token is replaced before the entry is stored, and only the
 *     *name* of the filtered field is kept. The original value is not written
 *     anywhere, not into the file and not into a log line.
 *   - The body of an entry is bounded, and the library is bounded, so neither
 *     a single note nor the collection can grow without a limit.
 *   - A persistence failure never damages the data that is already there. A
 *     write goes to a temporary file first and replaces the real file only
 *     after the bytes are on the disk.
 *
 * Nothing in this module executes a runbook. It stores, bounds and finds
 * text; the agent stays the one that decides what to run.
 */
import { open, mkdir, rename, chmod, unlink, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createSerialWriteQueue } from "./serial-write-queue.mjs";

export const RUNBOOK_FILE_NAME = "runbooks.json";
export const RUNBOOK_VERSION = 1;
export const RUNBOOK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const DEFAULT_MAX_ENTRIES = 500;
export const MAX_RUNBOOK_BODY_LENGTH = 64 * 1024;
export const MAX_RUNBOOK_TITLE_LENGTH = 200;
export const MAX_RUNBOOK_SOURCE_LENGTH = 512;
export const MAX_RUNBOOK_TAGS = 16;
export const MAX_RUNBOOK_TAG_LENGTH = 40;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;
export const MAX_SEARCH_TOKENS = 16;
export const MAX_SEARCH_TOKEN_LENGTH = 64;
export const MAX_SNIPPET_LENGTH = 220;

const REDACTED_VALUE = "[已隐藏]";
const REDACTED_TOKEN = "[已隐藏令牌]";

// A field whose name mentions one of these words carries a secret. The name
// is the only thing that is looked at; the value is never inspected.
const SENSITIVE_FIELD_PATTERN = /(key|token|secret|password|passwd|pwd|authorization|cookie|credential|private|bearer|sessionid|apikey|access[_-]?key|refresh[_-]?key)/i;
// The same rule for a Chinese field name, because a runbook is written by a
// person and a person writes "密码: ...".
const SENSITIVE_FIELD_PATTERN_CJK = /(密码|口令|密钥|令牌|凭证|授权)/;

// A value that has the shape of a token is filtered even without a field
// name around it.
const TOKEN_VALUE_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function boundedInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  if (rounded < 0) return 0;
  return Math.min(rounded, max);
}

/**
 * Removes the values of credential like fields and reports the names of the
 * fields that were touched. The original value is dropped inside this
 * function and never leaves it.
 *
 * @param {string} value
 * @returns {{ text: string, fields: string[] }}
 */
export function redactRunbookText(value) {
  const fields = new Set();
  const pairs = [
    { pattern: /([A-Za-z_][A-Za-z0-9_.-]{0,63})(\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;)}\]]+)/g, sensitive: SENSITIVE_FIELD_PATTERN },
    { pattern: /([\u4e00-\u9fff]{2,8})(\s*[:：=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;)}\]]+)/g, sensitive: SENSITIVE_FIELD_PATTERN_CJK }
  ];
  let output = String(value ?? "");
  for (const { pattern, sensitive } of pairs) {
    output = output.replace(pattern, (match, field, separator) => {
      if (!sensitive.test(field)) return match;
      fields.add(field.trim().toLowerCase());
      return field + separator + REDACTED_VALUE;
    });
  }
  output = output.replace(TOKEN_VALUE_PATTERN, () => {
    // A token without a field name around it is reported as a value of the
    // body itself.
    fields.add("body");
    return REDACTED_TOKEN;
  });
  return { text: output, fields: [...fields].sort() };
}

function normalizeTags(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const tags = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const tag = item.trim().toLowerCase();
    if (!tag) continue;
    if (tag.length > MAX_RUNBOOK_TAG_LENGTH) return null;
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > MAX_RUNBOOK_TAGS) return null;
  return tags;
}

function compareEntries(left, right) {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1;
  return left.id < right.id ? -1 : (left.id > right.id ? 1 : 0);
}

function snippetAround(text, needle) {
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return "";
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + needle.length + 120);
  const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + slice.slice(0, MAX_SNIPPET_LENGTH) + (end < text.length ? "…" : "");
}

/**
 * Creates the runbook library.
 *
 * @param {object} [options]
 * @param {string} [options.dataDir]   when set, the library is persisted in
 *                                      `<dataDir>/runbooks.json`
 * @param {number} [options.maxEntries] the size limit of the library
 * @param {() => string} [options.now]  the clock, for a deterministic test
 * @param {object} [options.fs]         the file system calls, so a test can
 *                                      inject a failing write
 */
export function createRunbookStore({ dataDir = "", maxEntries = DEFAULT_MAX_ENTRIES, now = () => new Date().toISOString(), fs = { open, mkdir, rename, chmod, unlink, readFile } } = {}) {
  if (typeof dataDir !== "string") throw new TypeError("dataDir must be a string");
  if (!Number.isFinite(maxEntries) || maxEntries < 1) throw new TypeError("maxEntries must be a positive number");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (!isPlainObject(fs)) throw new TypeError("fs must be an object");

  const limitEntries = Math.trunc(maxEntries);
  const persistent = Boolean(dataDir.trim());
  const filePath = persistent ? join(dataDir, RUNBOOK_FILE_NAME) : "";
  const queue = createSerialWriteQueue();

  let entries = new Map();
  let updatedAt = null;
  let loaded = false;

  function serialize(map, stamp) {
    return {
      version: RUNBOOK_VERSION,
      updatedAt: stamp,
      entries: [...map.values()].map(entry => ({
        id: entry.id,
        title: entry.title,
        tags: entry.tags,
        body: entry.body,
        source: entry.source,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        redactedFields: entry.redactedFields
      }))
    };
  }

  function adoptEntry(value) {
    if (!isPlainObject(value)) return null;
    const id = text(value.id).trim();
    if (!RUNBOOK_ID_PATTERN.test(id)) return null;
    const title = text(value.title).trim();
    if (!title) return null;
    const body = text(value.body);
    if (!body || body.length > MAX_RUNBOOK_BODY_LENGTH) return null;
    const tags = normalizeTags(value.tags);
    if (tags === null) return null;
    return {
      id,
      title,
      tags,
      body,
      source: text(value.source).trim().slice(0, MAX_RUNBOOK_SOURCE_LENGTH),
      createdAt: text(value.createdAt) || null,
      updatedAt: text(value.updatedAt) || null,
      redactedFields: Array.isArray(value.redactedFields) ? value.redactedFields.filter(name => typeof name === "string") : []
    };
  }

  async function load() {
    if (!persistent || loaded) return;
    loaded = true;
    let raw = "";
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      // A missing file is a library that is not filled yet.
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A broken file is ignored, it is never silently rewritten.
      return;
    }
    if (!isPlainObject(parsed) || parsed.version !== RUNBOOK_VERSION || !Array.isArray(parsed.entries)) return;
    const adopted = new Map();
    for (const item of parsed.entries.slice(0, limitEntries)) {
      const entry = adoptEntry(item);
      if (entry) adopted.set(entry.id, entry);
    }
    entries = adopted;
    updatedAt = text(parsed.updatedAt) || null;
  }

  async function persist(map) {
    const stamp = now();
    const payload = Buffer.from(JSON.stringify(serialize(map, stamp)), "utf8");
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const tempPath = join(dataDir, ".runbooks-" + randomUUID() + ".tmp");
    let handle;
    let renamed = false;
    try {
      handle = await fs.open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      await handle.writeFile(payload);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(tempPath, filePath);
      renamed = true;
      await fs.chmod(filePath, 0o600);
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (!renamed) await fs.unlink(tempPath).catch(() => {});
    }
    updatedAt = stamp;
  }

  function publicEntry(entry) {
    return {
      id: entry.id,
      title: entry.title,
      tags: [...entry.tags],
      body: entry.body,
      source: entry.source,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      redactedFields: [...entry.redactedFields]
    };
  }

  /**
   * Stores an entry. The id must be new: an existing id is refused.
   *
   * @param {object} entry { id, title, tags?, body, source? }
   * @returns {Promise<object>} { written: true, entry } or
   *                            { written: false, reason, code }
   */
  function put(entry) {
    return queue(async () => {
      if (!isPlainObject(entry)) return { written: false, reason: "条目必须是一个对象。", code: "invalid-entry" };
      const id = text(entry.id).trim();
      if (!RUNBOOK_ID_PATTERN.test(id)) {
        return { written: false, reason: "条目 id 不合法，只允许小写字母、数字、点、下划线和短横线，且最长 64 位。", code: "invalid-id" };
      }
      const title = text(entry.title).trim();
      if (!title) return { written: false, reason: "条目标题不能为空。", code: "invalid-title" };
      if (title.length > MAX_RUNBOOK_TITLE_LENGTH) {
        return { written: false, reason: `条目标题超过 ${MAX_RUNBOOK_TITLE_LENGTH} 个字符上限。`, code: "invalid-title" };
      }
      const body = text(entry.body);
      if (!body.trim()) return { written: false, reason: "条目正文不能为空。", code: "invalid-body" };
      if (body.length > MAX_RUNBOOK_BODY_LENGTH) {
        return { written: false, reason: `条目正文超过 ${MAX_RUNBOOK_BODY_LENGTH} 个字符上限。`, code: "body-too-large" };
      }
      const tags = normalizeTags(entry.tags);
      if (tags === null) {
        return { written: false, reason: `条目标签不合法：最多 ${MAX_RUNBOOK_TAGS} 个，每个不超过 ${MAX_RUNBOOK_TAG_LENGTH} 个字符。`, code: "invalid-tags" };
      }
      if (entries.has(id)) {
        return { written: false, reason: `条目 ${id} 已存在，拒绝覆盖。`, code: "duplicate-entry" };
      }
      if (entries.size >= limitEntries) {
        return { written: false, reason: `运行手册库已达 ${limitEntries} 条上限。`, code: "max-entries-reached" };
      }
      const source = text(entry.source).trim();
      if (source.length > MAX_RUNBOOK_SOURCE_LENGTH) {
        return { written: false, reason: `条目来源超过 ${MAX_RUNBOOK_SOURCE_LENGTH} 个字符上限。`, code: "invalid-source" };
      }
      const redactedTitle = redactRunbookText(title);
      const redactedBody = redactRunbookText(body);
      const redactedSource = redactRunbookText(source);
      const redactedFields = [...new Set([...redactedTitle.fields, ...redactedBody.fields, ...redactedSource.fields])].sort();
      const stamp = now();
      const record = {
        id,
        title: redactedTitle.text,
        tags,
        body: redactedBody.text,
        source: redactedSource.text,
        createdAt: stamp,
        updatedAt: stamp,
        redactedFields
      };
      const next = new Map(entries);
      next.set(id, record);
      if (persistent) {
        try {
          await persist(next);
        } catch (error) {
          // The old data is still intact, the caller sees the reason.
          return { written: false, reason: `运行手册写入失败：${error?.message || "未知错误"}`, code: "persist-failed" };
        }
      } else {
        updatedAt = stamp;
      }
      entries = next;
      return { written: true, entry: publicEntry(record), redactedFields };
    });
  }

  /**
   * @param {string} id
   * @returns {object|null} the entry, or null when there is none
   */
  function get(id) {
    const entry = entries.get(text(id).trim());
    return entry ? publicEntry(entry) : null;
  }

  /**
   * @param {object} [options] { tag, limit, offset }
   * @returns {{ entries: object[], total: number, limit: number, offset: number }}
   */
  function list({ tag, limit, offset } = {}) {
    const wanted = text(tag).trim().toLowerCase();
    const all = [...entries.values()].sort(compareEntries);
    const filtered = wanted ? all.filter(entry => entry.tags.includes(wanted)) : all;
    const max = boundedInt(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const start = boundedInt(offset, 0, Number.MAX_SAFE_INTEGER);
    return {
      entries: filtered.slice(start, start + max).map(publicEntry),
      total: filtered.length,
      limit: max,
      offset: start
    };
  }

  /**
   * Removes an entry.
   *
   * @param {string} id
   * @returns {Promise<object>} { removed: true, id } or { removed: false, reason, code }
   */
  function remove(id) {
    return queue(async () => {
      const key = text(id).trim();
      if (!entries.has(key)) return { removed: false, reason: `条目 ${key} 不存在。`, code: "not-found" };
      const next = new Map(entries);
      next.delete(key);
      if (persistent) {
        try {
          await persist(next);
        } catch (error) {
          return { removed: false, reason: `运行手册删除失败：${error?.message || "未知错误"}`, code: "persist-failed" };
        }
      }
      entries = next;
      return { removed: true, id: key };
    });
  }

  /**
   * A plain text search over the title, the tags and the body. Every token of
   * the query has to be found, the order of the result is stable.
   *
   * @param {string} query
   * @param {object} [options] { limit }
   * @returns {{ results: object[], total: number, limit: number }}
   */
  function search(query, { limit } = {}) {
    const raw = text(query).trim();
    const max = boundedInt(limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    if (!raw) return { results: [], total: 0, limit: max };
    const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length || tokens.length > MAX_SEARCH_TOKENS || tokens.some(token => token.length > MAX_SEARCH_TOKEN_LENGTH)) {
      return { results: [], total: 0, limit: max };
    }
    const scored = [];
    for (const entry of entries.values()) {
      const title = entry.title.toLowerCase();
      const tags = entry.tags.join(" ");
      const body = entry.body.toLowerCase();
      let score = 0;
      let missing = false;
      for (const token of tokens) {
        let tokenScore = 0;
        if (title.includes(token)) tokenScore += 3;
        if (tags.includes(token)) tokenScore += 2;
        if (body.includes(token)) tokenScore += 1;
        if (!tokenScore) {
          missing = true;
          break;
        }
        score += tokenScore;
      }
      if (missing) continue;
      const hit = tokens.find(token => body.includes(token));
      const snippet = hit ? snippetAround(entry.body, hit) : snippetAround(entry.title, tokens[0]);
      scored.push({ entry, score, snippet });
    }
    scored.sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      const order = compareEntries(left.entry, right.entry);
      return order;
    });
    return {
      results: scored.slice(0, max).map(item => ({
        id: item.entry.id,
        title: item.entry.title,
        tags: [...item.entry.tags],
        source: item.entry.source,
        score: item.score,
        snippet: item.snippet,
        updatedAt: item.entry.updatedAt
      })),
      total: scored.length,
      limit: max
    };
  }

  /**
   * @returns {{ count: number, tags: string[], updatedAt: string|null, maxEntries: number, persisted: boolean }}
   */
  function stats() {
    const tags = new Set();
    for (const entry of entries.values()) for (const tag of entry.tags) tags.add(tag);
    return {
      count: entries.size,
      tags: [...tags].sort(),
      updatedAt,
      maxEntries: limitEntries,
      persisted: persistent
    };
  }

  return { put, get, list, remove, search, stats, load };
}

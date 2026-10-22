/**
 * Phase 173 — 诊断历史与知识修正（模块 03「AI 故障诊断与自动修复」的沉淀层）
 *
 * Phase 162 的 `app/diagnostics.mjs` 能产出一份诊断报告，Phase 167 的
 * `app/diagnostic-evidence.mjs` 能把仓库里的四类记录整理成证据，但两者的结论
 * 都是一次性的：诊断做完就蒸发了。本模块给诊断结论一个**有界的记忆**：
 *
 *   - 记录一次诊断（症状、候选原因、证据引用、采取的动作、结论状态）；
 *   - 标记过期（只提示「建议复核或归档」，不自动删除、不自动改结论）；
 *   - 记录人工修正（只追加修正痕迹，原始条目保留，全程可追溯）；
 *   - 汇总分布（open / resolved / ignored、过期数、按症状聚合的命中数）。
 *
 * 纯内存实现：无 I/O、无第三方依赖、无模型调用。数据不落盘（见文档「遗留限制」）。
 *
 * 红线：
 *   - 症状与备注落库前必须脱敏，疑似密钥不得原样入库；
 *   - 过期只提示，不自动删除、不自动改结论；
 *   - 修正只追加，不抹掉原始条目；
 *   - 条数与字段长度都有上限，内存占用有界。
 */

import { randomUUID } from "node:crypto";

/** 默认保留的诊断条目数。 */
export const DEFAULT_MAX_DIAGNOSIS_ENTRIES = 200;

/** 默认的过期阈值：7 天。 */
export const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** 症状长度上限（2 KiB）。 */
export const MAX_SYMPTOM_LENGTH = 2048;

/** 备注长度上限。 */
export const MAX_NOTE_LENGTH = 1024;

/** 单条候选原因 / 动作的长度上限。 */
export const MAX_ITEM_LENGTH = 512;

/** 单条证据引用的长度上限。 */
export const MAX_EVIDENCE_REF_LENGTH = 256;

/** 候选原因 / 动作 / 证据引用的条数上限。 */
export const MAX_ITEMS = 50;

/** 修正事件的条数上限。 */
export const MAX_CORRECTIONS = 50;

/** list() 的默认分页大小与上限。 */
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

/** 结论状态取值。 */
export const DIAGNOSIS_OUTCOMES = Object.freeze(["open", "resolved", "ignored"]);

/** 脱敏后的占位文本。 */
const REDACTED_VALUE = "[已隐藏]";
const REDACTED_TOKEN = "[已隐藏令牌]";

/** 字段名里出现这些词，说明该字段带密钥。 */
const SENSITIVE_FIELD_PATTERN = /(key|token|secret|password|passwd|pwd|authorization|cookie|credential|private|bearer|sessionid|apikey|access[_-]?key|refresh[_-]?key)/i;

/** 中文里同样表示密钥的词。 */
const SENSITIVE_FIELD_PATTERN_CJK = /(密码|口令|密钥|令牌|凭证|授权)/;

/** 形如密钥的取值，即使没有字段名也会被过滤。 */
const TOKEN_VALUE_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;

/** 过期提示文案。 */
const STALE_PROMPT = "建议复核或归档";

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
 * 去掉控制字符与多余空白。
 *
 * @param {string} value
 * @returns {string}
 */
function flatten(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 抹掉疑似密钥的片段，并报告被触碰的字段名。
 *
 * 与 `app/runbook-store.mjs` 的 `redactRunbookText()` 同一思路：字段名决定
 * 是否脱敏，取值本身不被解释；没有字段名的密钥形态按令牌整体抹掉。
 *
 * @param {string} value
 * @returns {{ text: string, fields: string[] }}
 */
export function redactDiagnosisText(value) {
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
    fields.add("value");
    return REDACTED_TOKEN;
  });
  return { text: output, fields: [...fields].sort() };
}

/**
 * 归一化一组字符串条目（候选原因 / 动作 / 证据引用）。
 *
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {{ items: string[], redactedFields: string[] }|null} 非法输入返回 null
 */
function normalizeItems(value, maxLength) {
  if (value === undefined || value === null) return { items: [], redactedFields: [] };
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_ITEMS) return null;
  const items = [];
  const redactedFields = new Set();
  for (const item of value) {
    if (typeof item !== "string") return null;
    const raw = flatten(item);
    if (!raw) continue;
    const redacted = redactDiagnosisText(raw);
    for (const field of redacted.fields) redactedFields.add(field);
    const clean = flatten(redacted.text).slice(0, maxLength);
    if (clean) items.push(clean);
  }
  return { items, redactedFields: [...redactedFields].sort() };
}

/**
 * 创建诊断历史库。
 *
 * @param {object} [options]
 * @param {number} [options.maxEntries=200]   保留的条目数上限，超出丢弃最旧的
 * @param {number} [options.staleAfterMs]     过期阈值，默认 7 天
 * @param {() => string|Date} [options.now]   时钟，测试可注入
 * @param {() => string} [options.id]         id 生成器，测试可注入
 * @returns {object} 诊断历史库
 */
export function createDiagnosisHistory({ maxEntries = DEFAULT_MAX_DIAGNOSIS_ENTRIES, staleAfterMs = DEFAULT_STALE_AFTER_MS, now = () => new Date().toISOString(), id = () => randomUUID() } = {}) {
  if (!Number.isFinite(maxEntries) || maxEntries < 1) throw new TypeError("maxEntries must be a positive number");
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) throw new TypeError("staleAfterMs must be a non-negative number");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof id !== "function") throw new TypeError("id must be a function");

  const limitEntries = Math.trunc(maxEntries);
  const staleAfter = Math.trunc(staleAfterMs);
  const entries = new Map();
  let sequence = 0;

  function stamp() {
    const value = now();
    if (value instanceof Date) return value.toISOString();
    const raw = text(value).trim();
    return raw;
  }

  function millis(stampValue) {
    const parsed = Date.parse(stampValue);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function compareEntries(left, right) {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
    return left.sequence < right.sequence ? 1 : -1;
  }

  function publicEntry(entry) {
    return {
      id: entry.id,
      symptom: entry.symptom,
      causes: [...entry.causes],
      evidenceRefs: [...entry.evidenceRefs],
      actions: [...entry.actions],
      outcome: entry.outcome,
      note: entry.note,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      stale: entry.stale,
      staleAt: entry.staleAt,
      stalePrompt: entry.stalePrompt,
      corrections: entry.corrections.map(item => ({ ...item })),
      redactedFields: [...entry.redactedFields]
    };
  }

  /**
   * 记录一次诊断。
   *
   * @param {{symptom: string, causes?: string[], evidenceRefs?: string[], actions?: string[], outcome?: string, note?: string}} input
   * @returns {{recorded: true, entry: object}|{recorded: false, reason: string, code: string}}
   */
  function record(input) {
    if (!isPlainObject(input)) {
      return { recorded: false, reason: "诊断条目必须是对象。", code: "invalid-entry" };
    }
    const rawSymptom = flatten(input.symptom);
    if (!rawSymptom) {
      return { recorded: false, reason: "症状不能为空。", code: "invalid-symptom" };
    }
    if (rawSymptom.length > MAX_SYMPTOM_LENGTH) {
      return { recorded: false, reason: `症状长度不能超过 ${MAX_SYMPTOM_LENGTH} 字符。`, code: "symptom-too-long" };
    }
    const outcome = text(input.outcome).trim() || "open";
    if (!DIAGNOSIS_OUTCOMES.includes(outcome)) {
      return { recorded: false, reason: `结论状态必须是 ${DIAGNOSIS_OUTCOMES.join(" / ")} 之一。`, code: "invalid-outcome" };
    }
    const causes = normalizeItems(input.causes, MAX_ITEM_LENGTH);
    if (causes === null) {
      return { recorded: false, reason: "候选原因必须是字符串数组且条数受限。", code: "invalid-causes" };
    }
    const evidenceRefs = normalizeItems(input.evidenceRefs, MAX_EVIDENCE_REF_LENGTH);
    if (evidenceRefs === null) {
      return { recorded: false, reason: "证据引用必须是字符串数组且条数受限。", code: "invalid-evidence" };
    }
    const actions = normalizeItems(input.actions, MAX_ITEM_LENGTH);
    if (actions === null) {
      return { recorded: false, reason: "处理动作必须是字符串数组且条数受限。", code: "invalid-actions" };
    }
    const rawNote = flatten(input.note);
    if (rawNote.length > MAX_NOTE_LENGTH) {
      return { recorded: false, reason: `备注长度不能超过 ${MAX_NOTE_LENGTH} 字符。`, code: "note-too-long" };
    }
    const redactedSymptom = redactDiagnosisText(rawSymptom);
    const redactedNote = redactDiagnosisText(rawNote);
    const redactedFields = new Set([
      ...redactedSymptom.fields,
      ...redactedNote.fields,
      ...causes.redactedFields,
      ...evidenceRefs.redactedFields,
      ...actions.redactedFields
    ]);
    const at = stamp();
    sequence += 1;
    const entry = {
      id: text(id()).trim() || `diagnosis-${sequence}`,
      sequence,
      symptom: flatten(redactedSymptom.text).slice(0, MAX_SYMPTOM_LENGTH),
      causes: causes.items,
      evidenceRefs: evidenceRefs.items,
      actions: actions.items,
      outcome,
      note: flatten(redactedNote.text).slice(0, MAX_NOTE_LENGTH),
      createdAt: at,
      updatedAt: at,
      stale: false,
      staleAt: null,
      stalePrompt: "",
      corrections: [],
      redactedFields: [...redactedFields].sort()
    };
    entries.set(entry.id, entry);
    // 超出上限时丢弃最旧的条目。
    while (entries.size > limitEntries) {
      const oldest = [...entries.values()].sort(compareEntries).at(-1);
      if (!oldest) break;
      entries.delete(oldest.id);
    }
    return { recorded: true, entry: publicEntry(entry) };
  }

  /**
   * 列出诊断历史。默认按时间倒序。
   *
   * @param {{symptom?: string, limit?: number, offset?: number}} [options]
   * @returns {{entries: object[], total: number, limit: number, offset: number}}
   */
  function list({ symptom, limit, offset } = {}) {
    const wanted = flatten(symptom).toLowerCase();
    const all = [...entries.values()].sort(compareEntries);
    const filtered = wanted
      ? all.filter(entry => entry.symptom.toLowerCase().includes(wanted))
      : all;
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
   * @param {string} entryId
   * @returns {object|null}
   */
  function get(entryId) {
    const entry = entries.get(text(entryId).trim());
    return entry ? publicEntry(entry) : null;
  }

  /**
   * 更新一条诊断历史。只能改状态、备注、原因、动作与证据引用。
   *
   * @param {string} entryId
   * @param {{outcome?: string, note?: string, causes?: string[], evidenceRefs?: string[], actions?: string[]}} patch
   * @returns {{updated: true, entry: object}|{updated: false, reason: string, code: string}}
   */
  function update(entryId, patch) {
    const key = text(entryId).trim();
    const entry = entries.get(key);
    if (!entry) {
      return { updated: false, reason: `诊断条目 ${key} 不存在。`, code: "not-found" };
    }
    if (!isPlainObject(patch)) {
      return { updated: false, reason: "更新内容必须是对象。", code: "invalid-patch" };
    }
    const next = { ...entry };
    if (patch.outcome !== undefined) {
      const outcome = text(patch.outcome).trim();
      if (!DIAGNOSIS_OUTCOMES.includes(outcome)) {
        return { updated: false, reason: `结论状态必须是 ${DIAGNOSIS_OUTCOMES.join(" / ")} 之一。`, code: "invalid-outcome" };
      }
      next.outcome = outcome;
    }
    if (patch.note !== undefined) {
      const rawNote = flatten(patch.note);
      if (rawNote.length > MAX_NOTE_LENGTH) {
        return { updated: false, reason: `备注长度不能超过 ${MAX_NOTE_LENGTH} 字符。`, code: "note-too-long" };
      }
      const redacted = redactDiagnosisText(rawNote);
      for (const field of redacted.fields) next.redactedFields = [...new Set([...next.redactedFields, field])].sort();
      next.note = flatten(redacted.text).slice(0, MAX_NOTE_LENGTH);
    }
    for (const [field, maxLength] of [["causes", MAX_ITEM_LENGTH], ["evidenceRefs", MAX_EVIDENCE_REF_LENGTH], ["actions", MAX_ITEM_LENGTH]]) {
      if (patch[field] === undefined) continue;
      const normalized = normalizeItems(patch[field], maxLength);
      if (normalized === null) {
        return { updated: false, reason: `${field} 必须是字符串数组且条数受限。`, code: `invalid-${field.toLowerCase()}` };
      }
      for (const redactedField of normalized.redactedFields) next.redactedFields = [...new Set([...next.redactedFields, redactedField])].sort();
      next[field] = normalized.items;
    }
    next.updatedAt = stamp();
    entries.set(key, next);
    return { updated: true, entry: publicEntry(next) };
  }

  /**
   * 删除一条诊断历史。
   *
   * @param {string} entryId
   * @returns {{removed: true, id: string}|{removed: false, reason: string, code: string}}
   */
  function remove(entryId) {
    const key = text(entryId).trim();
    if (!entries.has(key)) {
      return { removed: false, reason: `诊断条目 ${key} 不存在。`, code: "not-found" };
    }
    entries.delete(key);
    return { removed: true, id: key };
  }

  /**
   * 标记一条仍然 open 的历史为过期，并给出复核提示。
   *
   * 只打标记，不删除、不改结论。
   *
   * @param {string} entryId
   * @returns {{stale: true, entry: object, prompt: string, alreadyStale: boolean}|{stale: false, reason: string, code: string}}
   */
  function markStale(entryId) {
    const key = text(entryId).trim();
    const entry = entries.get(key);
    if (!entry) {
      return { stale: false, reason: `诊断条目 ${key} 不存在。`, code: "not-found" };
    }
    if (entry.stale) {
      return { stale: true, entry: publicEntry(entry), prompt: entry.stalePrompt || STALE_PROMPT, alreadyStale: true };
    }
    if (entry.outcome !== "open") {
      return { stale: false, reason: `结论为 ${entry.outcome} 的条目不标记过期。`, code: "not-open" };
    }
    const created = millis(entry.createdAt);
    const current = millis(stamp());
    if (created === null || current === null) {
      return { stale: false, reason: "时间戳无法解析，未标记过期。", code: "invalid-timestamp" };
    }
    if (current - created <= staleAfter) {
      return { stale: false, reason: "条目尚未超过过期阈值。", code: "not-expired" };
    }
    const next = { ...entry, stale: true, staleAt: stamp(), stalePrompt: STALE_PROMPT, updatedAt: stamp() };
    entries.set(key, next);
    return { stale: true, entry: publicEntry(next), prompt: STALE_PROMPT, alreadyStale: false };
  }

  /**
   * 针对某个症状给出复核 / 更新提示。
   *
   * 命中同症状的历史条目：已解决的给出「可复用结论」，过期的给出「建议复核或归档」，
   * 有修正记录的给出「结论已被修正，建议复核」。
   *
   * @param {{symptom: string, limit?: number}} [options]
   * @returns {{suggestions: object[], total: number, limit: number}}
   */
  function suggestCorrections({ symptom, limit } = {}) {
    const wanted = flatten(symptom).toLowerCase();
    if (!wanted) return { suggestions: [], total: 0, limit: boundedInt(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT) };
    const max = boundedInt(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const matches = [...entries.values()]
      .filter(entry => entry.symptom.toLowerCase().includes(wanted))
      .sort(compareEntries);
    const suggestions = [];
    for (const entry of matches) {
      let prompt = "";
      let reason = "";
      if (entry.corrections.length > 0) {
        prompt = "历史结论已被修正，建议复核";
        reason = `该症状有 ${entry.corrections.length} 次修正记录。`;
      } else if (entry.stale) {
        prompt = STALE_PROMPT;
        reason = "该症状的历史结论已过期。";
      } else if (entry.outcome === "resolved") {
        prompt = "该症状此前已解决，建议先参考历史结论";
        reason = "历史条目结论为 resolved。";
      } else if (entry.outcome === "ignored") {
        prompt = "该症状此前被忽略，建议确认是否仍然忽略";
        reason = "历史条目结论为 ignored。";
      } else {
        prompt = "该症状仍有未闭环的历史结论，建议复核";
        reason = "历史条目结论为 open。";
      }
      suggestions.push({
        id: entry.id,
        symptom: entry.symptom,
        outcome: entry.outcome,
        stale: entry.stale,
        corrections: entry.corrections.length,
        prompt,
        reason,
        updatedAt: entry.updatedAt
      });
      if (suggestions.length >= max) break;
    }
    return { suggestions, total: matches.length, limit: max };
  }

  /**
   * 记录一次人工修正。
   *
   * 原始条目不被抹掉：只追加一条修正事件（修正前后结论、时间、原因），
   * 并把当前结论更新为修正后的值。
   *
   * @param {string} entryId
   * @param {{outcome?: string, note?: string, correctedBy?: string}} correction
   * @returns {{corrected: true, entry: object, correction: object}|{corrected: false, reason: string, code: string}}
   */
  function applyCorrection(entryId, correction) {
    const key = text(entryId).trim();
    const entry = entries.get(key);
    if (!entry) {
      return { corrected: false, reason: `诊断条目 ${key} 不存在。`, code: "not-found" };
    }
    if (!isPlainObject(correction)) {
      return { corrected: false, reason: "修正内容必须是对象。", code: "invalid-correction" };
    }
    const outcome = text(correction.outcome).trim();
    if (!DIAGNOSIS_OUTCOMES.includes(outcome)) {
      return { corrected: false, reason: `结论状态必须是 ${DIAGNOSIS_OUTCOMES.join(" / ")} 之一。`, code: "invalid-outcome" };
    }
    const rawNote = flatten(correction.note);
    if (rawNote.length > MAX_NOTE_LENGTH) {
      return { corrected: false, reason: `修正原因长度不能超过 ${MAX_NOTE_LENGTH} 字符。`, code: "note-too-long" };
    }
    const redactedNote = redactDiagnosisText(rawNote);
    const redactedBy = redactDiagnosisText(flatten(correction.correctedBy)).text;
    const at = stamp();
    const event = {
      id: text(id()).trim() || `correction-${entry.corrections.length + 1}`,
      at,
      previousOutcome: entry.outcome,
      outcome,
      note: flatten(redactedNote.text).slice(0, MAX_NOTE_LENGTH),
      correctedBy: flatten(redactedBy).slice(0, MAX_ITEM_LENGTH)
    };
    const corrections = [...entry.corrections, event].slice(-MAX_CORRECTIONS);
    const redactedFields = [...new Set([
      ...entry.redactedFields,
      ...redactedNote.fields,
      ...(redactedBy !== flatten(correction.correctedBy) ? ["correctedBy"] : [])
    ])].sort();
    const next = {
      ...entry,
      outcome,
      note: event.note || entry.note,
      corrections,
      updatedAt: at,
      redactedFields
    };
    entries.set(key, next);
    return { corrected: true, entry: publicEntry(next), correction: { ...event } };
  }

  /**
   * @returns {{total: number, byOutcome: {open: number, resolved: number, ignored: number}, stale: number, bySymptom: {symptom: string, count: number}[], maxEntries: number, staleAfterMs: number}}
   */
  function stats() {
    const byOutcome = { open: 0, resolved: 0, ignored: 0 };
    const symptomCounts = new Map();
    let stale = 0;
    for (const entry of entries.values()) {
      if (Object.prototype.hasOwnProperty.call(byOutcome, entry.outcome)) byOutcome[entry.outcome] += 1;
      if (entry.stale) stale += 1;
      symptomCounts.set(entry.symptom, (symptomCounts.get(entry.symptom) || 0) + 1);
    }
    const bySymptom = [...symptomCounts.entries()]
      .map(([symptom, count]) => ({ symptom, count }))
      .sort((left, right) => (right.count - left.count) || left.symptom.localeCompare(right.symptom));
    return {
      total: entries.size,
      byOutcome,
      stale,
      bySymptom,
      maxEntries: limitEntries,
      staleAfterMs: staleAfter
    };
  }

  return Object.freeze({
    record,
    list,
    get,
    update,
    remove,
    markStale,
    suggestCorrections,
    applyCorrection,
    stats
  });
}

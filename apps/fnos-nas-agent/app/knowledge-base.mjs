// Phase 177 — 运维知识库与长期记忆（模块 12「个人知识库与长期记忆」）
// 纯逻辑层：零第三方依赖、零 I/O、无 node:child_process / node:http。
// 覆盖清单编号：K03 来源与可信度、K04 检索排序、K05 与实时状态分离、
// K08 文档沉淀、K09 知识更新提示、K10 冲突与过期。

export const KNOWLEDGE_SOURCES = Object.freeze([
  "official-doc",
  "field-observation",
  "manual-confirmation"
]);

export const KNOWLEDGE_VERIFICATION_STATES = Object.freeze([
  "verified",
  "unverified",
  "stale",
  "conflicted"
]);

export const KNOWLEDGE_OPERATIONS = Object.freeze(["write", "verify", "archive"]);

export const DEFAULT_MAX_ENTRIES = 500;
export const DEFAULT_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;
export const MAX_BODY_LENGTH = 8000;
export const MAX_SUMMARY_LENGTH = 300;
export const MAX_TITLE_LENGTH = 200;
export const MAX_TAGS = 20;
export const MAX_FACTS = 30;
export const MAX_VERSIONS = 20;
export const MAX_CONFLICTS = 20;

const SOURCE_CONFIDENCE = Object.freeze({
  "official-doc": "high",
  "field-observation": "medium",
  "manual-confirmation": "high"
});

const FIELD_SECRET_PATTERN =
  /(api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|refresh[_-]?token|auth[_-]?token|access[_-]?token|bearer|token|secret|password|passwd|pwd|passphrase|credential|private[_-]?key|session[_-]?id|cookie)/i;
const FIELD_SECRET_PATTERN_CN = /(密码|口令|密钥|令牌|凭证|授权码|私钥)/;
const TOKEN_VALUE_PATTERN =
  /\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;
const ABSOLUTE_PATH_PATTERN =
  /(^|[\s"'`(])((?:[A-Za-z]:\\|\\\\)[^\s"'`)]*|\/(?:home|Users|var|mnt|media|opt|srv|etc|root|tmp|vol\d+)\/[^\s"'`)]*)/g;
const STACK_TRACE_PATTERN =
  /(^|\n)\s*at\s+[^\n]*\([^)]*:\d+:\d+\)|(^|\n)\s*at\s+[^\n]*:\d+:\d+|\bError:\s[^\n]*\n\s*at\s/;
const PROMPT_MARKER_PATTERN =
  /(<\|im_start\|>|<\|im_end\|>|###\s*(system|instruction|instructions)\b|\bsystem\s*prompt\b|\byou\s+are\s+(?:a|an)\b|^\s*\{[\s\S]{0,40}"role"\s*:\s*"system")/im;

const REDACTED = "[已隐藏]";
const REDACTED_TOKEN = "[已隐藏令牌]";

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampText(value, max, field) {
  if (typeof value !== "string") {
    return fail("knowledge-invalid-field", `Field ${field} must be a string`, { field });
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fail("knowledge-empty-field", `Field ${field} must not be empty`, { field });
  }
  if (trimmed.length > max) {
    return fail(
      "knowledge-field-too-long",
      `Field ${field} exceeds the ${max} character limit`,
      { field, limit: max }
    );
  }
  return trimmed;
}

function toIso(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? fallback : value.toISOString();
  }
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  }
  return fallback;
}

function normalizeTag(tag) {
  return String(tag).trim().toLowerCase();
}

/**
 * 脱敏：疑似密钥只回报字段名，不保留原文。
 * @returns {{text: string, fields: string[]}}
 */
export function redactKnowledgeText(value) {
  if (typeof value !== "string" || !value) {
    return { text: typeof value === "string" ? value : "", fields: [] };
  }
  const fields = new Set();
  let text = value.replace(
    /([A-Za-z0-9_.-]+)(\s*[:=]\s*)("?)([^\s"',;]{3,})\3/g,
    (match, name, separator, quote, raw) => {
      if (!FIELD_SECRET_PATTERN.test(name) && !FIELD_SECRET_PATTERN_CN.test(name)) {
        return match;
      }
      fields.add(String(name));
      return `${name}${separator}${quote}${REDACTED}${quote}`;
    }
  );
  text = text.replace(TOKEN_VALUE_PATTERN, () => {
    fields.add("token");
    return REDACTED_TOKEN;
  });
  return { text, fields: [...fields].sort() };
}

/**
 * 正文安全检查：拒绝提示词原文、异常栈、绝对本机路径。
 * @returns {{ok: boolean, code?: string, message?: string, reasons?: string[]}}
 */
export function inspectKnowledgeBody(body) {
  const reasons = [];
  if (typeof body !== "string" || !body.trim()) {
    return fail("knowledge-empty-body", "Knowledge body must not be empty");
  }
  if (body.length > MAX_BODY_LENGTH) {
    return fail(
      "knowledge-body-too-long",
      `Knowledge body exceeds the ${MAX_BODY_LENGTH} character limit`,
      { limit: MAX_BODY_LENGTH }
    );
  }
  if (PROMPT_MARKER_PATTERN.test(body)) {
    reasons.push("prompt-original");
  }
  if (STACK_TRACE_PATTERN.test(body)) {
    reasons.push("stack-trace");
  }
  if (ABSOLUTE_PATH_PATTERN.test(body)) {
    reasons.push("absolute-local-path");
  }
  if (reasons.length > 0) {
    return fail(
      "knowledge-body-rejected",
      "Knowledge body contains content that must not be stored",
      { reasons }
    );
  }
  return { ok: true, reasons: [] };
}

/**
 * 规范化一条知识输入。纯函数，不写任何存储。
 * @returns {{ok: true, entry: object, warnings: string[], redactedFields: string[]}
 *          | {ok: false, code: string, message: string}}
 */
export function normalizeKnowledgeEntry(input, { now = new Date().toISOString(), id = "kb-entry" } = {}) {
  if (!isPlainObject(input)) {
    return fail("knowledge-invalid-input", "Knowledge entry input must be an object");
  }
  const title = clampText(input.title ?? input.topic ?? "", MAX_TITLE_LENGTH, "title");
  if (title.ok === false) return title;

  const rawSummary = input.summary ?? "";
  if (typeof rawSummary !== "string") {
    return fail("knowledge-invalid-field", "Field summary must be a string", { field: "summary" });
  }
  if (rawSummary.length > MAX_SUMMARY_LENGTH) {
    return fail(
      "knowledge-field-too-long",
      `Field summary exceeds the ${MAX_SUMMARY_LENGTH} character limit`,
      { field: "summary", limit: MAX_SUMMARY_LENGTH }
    );
  }

  const bodyResult = inspectKnowledgeBody(input.body ?? "");
  if (bodyResult.ok === false) return bodyResult;

  const source = input.source;
  if (!KNOWLEDGE_SOURCES.includes(source)) {
    return fail(
      "knowledge-invalid-source",
      `Source must be one of: ${KNOWLEDGE_SOURCES.join(", ")}`,
      { field: "source" }
    );
  }

  const verification = input.verification ?? "unverified";
  if (!KNOWLEDGE_VERIFICATION_STATES.includes(verification)) {
    return fail(
      "knowledge-invalid-verification",
      `Verification must be one of: ${KNOWLEDGE_VERIFICATION_STATES.join(", ")}`,
      { field: "verification" }
    );
  }

  const tags = Array.isArray(input.tags) ? input.tags : [];
  if (tags.length > MAX_TAGS) {
    return fail("knowledge-field-too-long", `At most ${MAX_TAGS} tags are allowed`, {
      field: "tags",
      limit: MAX_TAGS
    });
  }
  const normalizedTags = [...new Set(tags.map(normalizeTag).filter(Boolean))].sort();

  const category = typeof input.category === "string" ? input.category.trim() : "";

  const rawFacts = Array.isArray(input.facts) ? input.facts : [];
  if (rawFacts.length > MAX_FACTS) {
    return fail("knowledge-field-too-long", `At most ${MAX_FACTS} facts are allowed`, {
      field: "facts",
      limit: MAX_FACTS
    });
  }
  const facts = [];
  for (const fact of rawFacts) {
    if (!isPlainObject(fact)) {
      return fail("knowledge-invalid-field", "Each fact must be an object", { field: "facts" });
    }
    const name = typeof fact.name === "string" ? fact.name.trim() : "";
    if (!name) {
      return fail("knowledge-invalid-field", "Each fact requires a name", { field: "facts" });
    }
    facts.push({
      name,
      value: typeof fact.value === "string" ? fact.value : String(fact.value ?? ""),
      collectedAt: toIso(fact.collectedAt, now),
      stale: fact.stale === true
    });
  }

  const collectedAt = toIso(input.collectedAt, now);
  const updatedAt = toIso(input.updatedAt, collectedAt);
  const expiresAt = toIso(input.expiresAt, null);

  const redactedSummary = redactKnowledgeText(rawSummary);
  const redactedBody = redactKnowledgeText(bodyResult.body ?? input.body ?? "");
  const redactedFields = [...new Set([...redactedSummary.fields, ...redactedBody.fields])].sort();

  const warnings = [];
  if (verification === "unverified") {
    warnings.push("entry-is-unverified");
  }
  if (redactedFields.length > 0) {
    warnings.push("secret-material-redacted");
  }
  if (facts.some((fact) => fact.stale)) {
    warnings.push("fact-marked-stale");
  }

  return {
    ok: true,
    warnings,
    redactedFields,
    entry: {
      id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : id,
      title: title.value,
      topic: typeof input.topic === "string" ? input.topic.trim() : title.value,
      conclusion: typeof input.conclusion === "string" ? input.conclusion.trim() : "",
      summary: redactedSummary.text,
      body: redactedBody.text,
      category,
      source,
      verification,
      confidence: input.confidence ?? SOURCE_CONFIDENCE[source] ?? "medium",
      speculative: verification !== "verified",
      tags: normalizedTags,
      facts,
      collectedAt,
      updatedAt,
      expiresAt,
      versions: Array.isArray(input.versions) ? input.versions.slice(-MAX_VERSIONS) : [],
      conflicts: [],
      stale: false,
      expired: false,
      archived: false,
      redactedFields
    }
  };
}

/**
 * 引用一条知识。未验证条目必须被标记为「推测」。
 * @returns {{ok: true, reference: object} | {ok: false, code: string, message: string}}
 */
export function referenceKnowledgeEntry(entry, { now = new Date().toISOString() } = {}) {
  if (!isPlainObject(entry)) {
    return fail("knowledge-invalid-entry", "Knowledge entry must be an object");
  }
  const speculative = entry.verification !== "verified";
  const confidence = speculative ? "speculative" : entry.confidence ?? "high";
  return {
    ok: true,
    reference: {
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      source: entry.source,
      verification: entry.verification,
      confidence,
      speculative,
      label: speculative ? "推测" : "已验证",
      collectedAt: entry.collectedAt ?? null,
      updatedAt: entry.updatedAt ?? null,
      factsAsOf: (entry.facts ?? []).map((fact) => ({
        name: fact.name,
        value: fact.value,
        collectedAt: fact.collectedAt ?? null,
        stale: fact.stale === true
      })),
      warning: speculative
        ? "该条目尚未验证，引用时必须标注为推测"
        : entry.stale
          ? "该条目可能已过期，引用时必须说明采集时间"
          : null
    }
  };
}

/**
 * K05：把知识条目里记录的事实与当前值比对，判断是否可能过期。
 * 事实一律按采集时间解读，绝不当作当前值。
 */
export function compareKnowledgeFacts(entry, current = {}, { now = new Date().toISOString() } = {}) {
  if (!isPlainObject(entry)) {
    return fail("knowledge-invalid-entry", "Knowledge entry must be an object");
  }
  if (!isPlainObject(current)) {
    return fail("knowledge-invalid-input", "Current values must be an object");
  }
  const changed = [];
  const missing = [];
  for (const fact of entry.facts ?? []) {
    if (!Object.prototype.hasOwnProperty.call(current, fact.name)) {
      missing.push({ name: fact.name, collectedAt: fact.collectedAt ?? null });
      continue;
    }
    const currentValue = String(current[fact.name] ?? "");
    if (currentValue !== fact.value) {
      changed.push({
        name: fact.name,
        recordedValue: fact.value,
        currentValue,
        collectedAt: fact.collectedAt ?? null
      });
    }
  }
  const stale =
    changed.length > 0 ||
    missing.length > 0 ||
    entry.stale === true ||
    (entry.facts ?? []).some((fact) => fact.stale === true);
  return {
    ok: true,
    stale,
    changed,
    missing,
    asOf: entry.collectedAt ?? now,
    note: "记录值仅代表采集时刻的观测，不代表当前状态"
  };
}

/**
 * K04：按关键词 / 标签 / 类别检索。
 */
export function searchKnowledgeEntries(entries, query = {}, { limit = DEFAULT_SEARCH_LIMIT } = {}) {
  if (!Array.isArray(entries)) {
    return fail("knowledge-invalid-input", "Entries must be an array");
  }
  const effectiveLimit = Math.min(
    Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_SEARCH_LIMIT),
    MAX_SEARCH_LIMIT
  );
  const keyword = typeof query.keyword === "string" ? query.keyword.trim().toLowerCase() : "";
  const tag = typeof query.tag === "string" ? query.tag.trim().toLowerCase() : "";
  const category = typeof query.category === "string" ? query.category.trim() : "";
  const source = typeof query.source === "string" ? query.source.trim() : "";

  const seen = new Set();
  const matched = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    if (entry.archived === true) continue;
    if (source && entry.source !== source) continue;
    if (category && (entry.category ?? "") !== category) continue;
    if (tag && !(entry.tags ?? []).includes(tag)) continue;
    if (keyword) {
      const haystack = [entry.title, entry.summary, entry.body, ...(entry.tags ?? [])]
        .filter((part) => typeof part === "string")
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(keyword)) continue;
    }
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    matched.push({
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      source: entry.source,
      confidence: entry.verification === "verified" ? entry.confidence ?? "high" : "speculative",
      speculative: entry.verification !== "verified",
      updatedAt: entry.updatedAt ?? null,
      collectedAt: entry.collectedAt ?? null,
      verification: entry.verification,
      stale: entry.stale === true,
      expired: entry.expired === true
    });
  }
  matched.sort((a, b) => {
    if (a.speculative !== b.speculative) return a.speculative ? 1 : -1;
    const time = String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
    if (time !== 0) return time;
    return String(a.id).localeCompare(String(b.id));
  });
  return {
    ok: true,
    total: matched.length,
    limit: effectiveLimit,
    entries: matched.slice(0, effectiveLimit)
  };
}

/**
 * K10：检测同一主题上的冲突结论。返回冲突标记，而不是随便选一个。
 */
export function detectKnowledgeConflicts(entries, { topic = "topic" } = {}) {
  if (!Array.isArray(entries)) {
    return fail("knowledge-invalid-input", "Entries must be an array");
  }
  const groups = new Map();
  for (const entry of entries) {
    if (!isPlainObject(entry) || entry.archived === true) continue;
    const assertion = entry[topic];
    if (typeof assertion !== "string" || !assertion.trim()) continue;
    const key = assertion.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const conflicts = [];
  for (const [key, group] of groups) {
    const values = new Set(
      group
        .map((entry) => (typeof entry.conclusion === "string" ? entry.conclusion.trim() : ""))
        .filter(Boolean)
    );
    if (values.size > 1) {
      conflicts.push({
        topic: key,
        count: group.length,
        entries: group.map((entry) => ({
          id: entry.id,
          title: entry.title,
          conclusion: entry.conclusion ?? null,
          source: entry.source,
          verification: entry.verification,
          collectedAt: entry.collectedAt ?? null
        })),
        resolution: null,
        note: "同一主题存在冲突结论，未做自动取舍"
      });
    }
  }
  return { ok: true, conflicts, total: conflicts.length };
}

/**
 * K09：知识更新提示——比对条目记录的版本与当前值。
 */
export function reviewKnowledgeUpdates(entries, current = {}, { now = new Date().toISOString() } = {}) {
  if (!Array.isArray(entries)) {
    return fail("knowledge-invalid-input", "Entries must be an array");
  }
  if (!isPlainObject(current)) {
    return fail("knowledge-invalid-input", "Current values must be an object");
  }
  const changed = [];
  for (const entry of entries) {
    if (!isPlainObject(entry) || entry.archived === true) continue;
    const comparison = compareKnowledgeFacts(entry, current, { now });
    if (!comparison.ok) continue;
    if (comparison.changed.length > 0 || comparison.missing.length > 0 || entry.stale === true) {
      changed.push({
        id: entry.id,
        title: entry.title,
        source: entry.source,
        verification: entry.verification,
        changedFacts: comparison.changed,
        missingFacts: comparison.missing,
        collectedAt: entry.collectedAt ?? null,
        prompt: "配置或版本已变化，建议复核该条目"
      });
    }
  }
  return { ok: true, changed, total: changed.length, checkedAt: now };
}

/**
 * 标记过期：超过 expiresAt，或未验证且超过 staleAfterMs。
 */
export function evaluateKnowledgeExpiry(entries, { now = new Date().toISOString(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  if (!Array.isArray(entries)) {
    return fail("knowledge-invalid-input", "Entries must be an array");
  }
  const nowTime = new Date(now).getTime();
  const expired = [];
  const stale = [];
  for (const entry of entries) {
    if (!isPlainObject(entry) || entry.archived === true) continue;
    if (entry.expiresAt && new Date(entry.expiresAt).getTime() <= nowTime) {
      expired.push({ id: entry.id, title: entry.title, expiresAt: entry.expiresAt });
      continue;
    }
    const collected = new Date(entry.collectedAt ?? entry.updatedAt ?? now).getTime();
    const age = nowTime - collected;
    if (age > staleAfterMs && entry.verification !== "verified") {
      stale.push({
        id: entry.id,
        title: entry.title,
        verification: entry.verification,
        collectedAt: entry.collectedAt ?? null,
        ageMs: age
      });
    }
  }
  return { ok: true, expired, stale, checkedAt: now };
}

/**
 * 知识库门面。默认内存存储；可通过 storage 注入持久化实现。
 * 所有写操作都走「先预览后提交」的两步接口。
 */
export function createKnowledgeBase({
  storage = null,
  maxEntries = DEFAULT_MAX_ENTRIES,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  now = () => new Date().toISOString(),
  id = "kb-entry"
} = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError("maxEntries must be a positive integer");
  }
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new TypeError("staleAfterMs must be a non-negative number");
  }
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }

  const entries = new Map();
  const pending = new Map();
  let counter = 0;

  const nextId = () => {
    counter += 1;
    return `${id}-${counter}`;
  };

  const persist = () => {
    if (storage && typeof storage.save === "function") {
      storage.save([...entries.values()]);
    }
  };

  const publicEntry = (entry) => ({ ...entry });

  const base = {
    /**
     * 第一步：预览一次写操作。返回 previewId，不落库。
     */
    preview(operation, input = {}) {
      if (!KNOWLEDGE_OPERATIONS.includes(operation)) {
        return fail("knowledge-invalid-operation", `Unknown operation: ${operation}`);
      }
      if (operation === "write") {
        const normalized = normalizeKnowledgeEntry(input, { now: now(), id: nextId() });
        if (normalized.ok === false) return normalized;
        const existing = entries.get(normalized.entry.id);
        const force = input.force === true;
        if (existing && !force) {
          return fail(
            "knowledge-duplicate-id",
            "An entry with the same id already exists; pass force to replace it",
            { id: normalized.entry.id }
          );
        }
        const warnings = [...normalized.warnings];
        if (existing) warnings.push("entry-replaced-with-force");
        const previewId = `preview-${nextId()}`;
        pending.set(previewId, {
          operation,
          entry: normalized.entry,
          warnings,
          redactedFields: normalized.redactedFields,
          replace: Boolean(existing)
        });
        return {
          ok: true,
          previewId,
          operation,
          entry: publicEntry(normalized.entry),
          warnings,
          redactedFields: normalized.redactedFields,
          existing: existing ? publicEntry(existing) : null,
          requiresForce: Boolean(existing) && !force
        };
      }
      if (operation === "verify") {
        const target = entries.get(input.id);
        if (!target) {
          return fail("knowledge-not-found", "Knowledge entry not found", { id: input.id });
        }
        const verification = input.verification ?? "verified";
        if (!KNOWLEDGE_VERIFICATION_STATES.includes(verification)) {
          return fail(
            "knowledge-invalid-verification",
            `Verification must be one of: ${KNOWLEDGE_VERIFICATION_STATES.join(", ")}`,
            { field: "verification" }
          );
        }
        const previewId = `preview-${nextId()}`;
        pending.set(previewId, { operation, id: input.id, verification });
        return {
          ok: true,
          previewId,
          operation,
          entry: publicEntry(target),
          warnings: [],
          redactedFields: [],
          requiresForce: false
        };
      }
      // archive
      const target = entries.get(input.id);
      if (!target) {
        return fail("knowledge-not-found", "Knowledge entry not found", { id: input.id });
      }
      const previewId = `preview-${nextId()}`;
      pending.set(previewId, { operation, id: input.id });
      return {
        ok: true,
        previewId,
        operation,
        entry: publicEntry(target),
        warnings: ["entry-will-be-archived"],
        redactedFields: [],
        requiresForce: false
      };
    },

    /**
     * 第二步：提交此前预览过的写操作。
     */
    commit(previewId) {
      const plan = pending.get(previewId);
      if (!plan) {
        return fail("knowledge-preview-not-found", "Unknown preview id", { previewId });
      }
      pending.delete(previewId);
      const timestamp = now();
      if (plan.operation === "write") {
        const entry = { ...plan.entry, updatedAt: timestamp };
        if (plan.replace) {
          const previous = entries.get(entry.id);
          entry.versions = [
            ...(previous?.versions ?? []),
            {
              version: entry.versions.length + 1,
              at: previous?.updatedAt ?? previous?.collectedAt ?? timestamp,
              title: previous?.title ?? null,
              summary: previous?.summary ?? null,
              verification: previous?.verification ?? null
            }
          ].slice(-MAX_VERSIONS);
        }
        entries.set(entry.id, entry);
        if (entries.size > maxEntries) {
          const oldest = [...entries.values()].sort((a, b) =>
            String(a.updatedAt ?? a.collectedAt ?? "").localeCompare(String(b.updatedAt ?? b.collectedAt ?? ""))
          )[0];
          if (oldest) entries.delete(oldest.id);
        }
        persist();
        return { ok: true, written: true, entry: publicEntry(entry) };
      }
      if (plan.operation === "verify") {
        const target = entries.get(plan.id);
        if (!target) {
          return fail("knowledge-not-found", "Knowledge entry not found", { id: plan.id });
        }
        target.verification = plan.verification;
        target.speculative = plan.verification !== "verified";
        target.confidence =
          plan.verification === "verified"
            ? SOURCE_CONFIDENCE[target.source] ?? "high"
            : "speculative";
        target.updatedAt = timestamp;
        persist();
        return { ok: true, written: true, entry: publicEntry(target) };
      }
      const target = entries.get(plan.id);
      if (!target) {
        return fail("knowledge-not-found", "Knowledge entry not found", { id: plan.id });
      }
      target.archived = true;
      target.updatedAt = timestamp;
      persist();
      return { ok: true, written: true, entry: publicEntry(target), archived: true };
    },

    /**
     * 放弃一次预览。
     */
    cancel(previewId) {
      return pending.delete(previewId)
        ? { ok: true, cancelled: true, previewId }
        : fail("knowledge-preview-not-found", "Unknown preview id", { previewId });
    },

    list({ limit = DEFAULT_SEARCH_LIMIT, offset = 0, includeArchived = false } = {}) {
      const all = [...entries.values()].filter((entry) => includeArchived || !entry.archived);
      all.sort((a, b) =>
        String(b.updatedAt ?? b.collectedAt ?? "").localeCompare(String(a.updatedAt ?? a.collectedAt ?? ""))
      );
      const safeLimit = Math.min(
        Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_SEARCH_LIMIT),
        MAX_SEARCH_LIMIT
      );
      const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0;
      return {
        ok: true,
        total: all.length,
        limit: safeLimit,
        offset: safeOffset,
        entries: all.slice(safeOffset, safeOffset + safeLimit).map(publicEntry)
      };
    },

    get(entryId) {
      const entry = entries.get(entryId);
      return entry ? { ok: true, entry: publicEntry(entry) } : fail("knowledge-not-found", "Knowledge entry not found", { id: entryId });
    },

    search(query = {}, options = {}) {
      return searchKnowledgeEntries([...entries.values()], query, options);
    },

    reference(entryId, options = {}) {
      const entry = entries.get(entryId);
      if (!entry) {
        return fail("knowledge-not-found", "Knowledge entry not found", { id: entryId });
      }
      return referenceKnowledgeEntry(entry, { now: now(), ...options });
    },

    compare(entryId, current = {}) {
      const entry = entries.get(entryId);
      if (!entry) {
        return fail("knowledge-not-found", "Knowledge entry not found", { id: entryId });
      }
      return compareKnowledgeFacts(entry, current, { now: now() });
    },

    review(current = {}) {
      return reviewKnowledgeUpdates([...entries.values()], current, { now: now() });
    },

    conflicts() {
      return detectKnowledgeConflicts([...entries.values()]);
    },

    /**
     * 刷新过期/陈旧标记（只打标记，不改结论，也不删除条目）。
     */
    refreshExpiry() {
      const all = [...entries.values()];
      const result = evaluateKnowledgeExpiry(all, { now: now(), staleAfterMs });
      if (result.ok === false) return result;
      for (const entry of all) {
        entry.expired = result.expired.some((item) => item.id === entry.id);
        entry.stale = result.stale.some((item) => item.id === entry.id);
        if (entry.expired && entry.verification === "unverified") {
          entry.verification = "stale";
        }
      }
      const conflicts = detectKnowledgeConflicts(all);
      for (const conflict of conflicts.conflicts ?? []) {
        for (const member of conflict.entries) {
          const entry = entries.get(member.id);
          if (!entry) continue;
          entry.conflicts = (entry.conflicts ?? []).filter((item) => item.topic !== conflict.topic);
          entry.conflicts.push({
            topic: conflict.topic,
            with: conflict.entries.filter((item) => item.id !== member.id).map((item) => item.id),
            note: conflict.note
          });
          if (entry.verification === "verified") {
            entry.verification = "conflicted";
          }
        }
      }
      persist();
      return { ok: true, expired: result.expired, stale: result.stale, conflicts: conflicts.conflicts ?? [] };
    },

    stats() {
      const all = [...entries.values()];
      const bySource = {};
      const byVerification = {};
      for (const entry of all) {
        bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
        byVerification[entry.verification] = (byVerification[entry.verification] ?? 0) + 1;
      }
      return {
        ok: true,
        total: all.length,
        archived: all.filter((entry) => entry.archived).length,
        bySource,
        byVerification,
        maxEntries,
        staleAfterMs,
        pendingPreviews: pending.size
      };
    }
  };

  if (storage && typeof storage.load === "function") {
    const loaded = storage.load();
    if (Array.isArray(loaded)) {
      for (const entry of loaded) {
        if (isPlainObject(entry) && typeof entry.id === "string") {
          entries.set(entry.id, { ...entry });
        }
      }
    }
  }

  return base;
}

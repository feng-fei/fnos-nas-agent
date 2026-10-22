/**
 * Phase 167 — 诊断证据源接入（模块 03「AI 故障诊断与自动修复」的证据来源层）
 *
 * Phase 162 的 `app/diagnostics.mjs` 只能消费调用方传入的证据，诊断引擎因此
 * 没有真正的证据来源。本模块提供这层来源：把仓库里已经存在的四类记录
 * （审计日志、工具调用轨迹、定时巡检、系统快照）整理成
 * `buildDiagnosticReport()` 需要的 evidence 形状。
 *
 * 纯函数模块：不调用模型、不做任何 I/O、不依赖第三方包。
 *
 * 红线：
 *   - 只允许白名单字段进入证据；提示词、密钥原文、原始异常栈一律不采集；
 *   - 证据条数有硬上限，超限截断并留下 truncated 标记；
 *   - 同一症状不会重复收录同一条证据；
 *   - 本模块只"读"传入的数据，不修改、不回写任何来源。
 */

/** 证据来源（枚举，顺序即收集顺序）。 */
export const DIAGNOSTIC_EVIDENCE_SOURCES = Object.freeze([
  "audit",
  "trace",
  "health-check",
  "snapshot"
]);

/** 每个来源最多保留的证据条数。 */
export const MAX_EVIDENCE_PER_SOURCE = 50;

/** 所有来源合计最多保留的证据条数。 */
export const MAX_EVIDENCE_TOTAL = 200;

/** 单条证据的明细最大长度。 */
const MAX_DETAIL_LENGTH = 240;

/** 审计记录里允许进入证据的字段。 */
const AUDIT_FIELDS = Object.freeze(["at", "method", "route", "statusCode", "outcome", "toolId", "risk", "target"]);

/** 工具轨迹里允许进入证据的字段。 */
const TRACE_FIELDS = Object.freeze(["toolId", "risk", "outcome", "errorClass", "durationMs", "startedAt", "endedAt"]);

/** 定时巡检里允许进入证据的字段。 */
const HEALTH_CHECK_FIELDS = Object.freeze(["name", "type", "lastStatus", "lastRunAt", "lastSummary"]);

/** 系统快照分段里允许进入证据的字段。 */
const SNAPSHOT_FIELDS = Object.freeze(["id", "title", "status", "note"]);

/** 快照数值里允许进入证据的键（其余键名不进入证据）。 */
const SNAPSHOT_VALUE_FIELDS = Object.freeze([
  "usagePercent", "usedPercent", "freePercent", "temperature", "loadAverage",
  "cpuPercent", "memoryPercent", "swapPercent", "temperatureC", "latencyMs", "online",
  "sizeBytes", "usedBytes", "freeBytes", "totalBytes", "availableBytes", "count",
  "total", "failed", "available", "containersTotal", "containersRunning", "state",
  "raidState", "health", "loadAverage"
]);

/** 明确禁止进入证据的字段名（大小写不敏感，按子串匹配）。 */
const FORBIDDEN_FIELD_PATTERN = /(prompt|apikey|api[-_]?key|secret|token|password|passwd|credential|authorization|cookie|sessionvalue|stack|traceback|prompttext|usermessage|usertext)/i;

/** 形如 `apiKey=xxx` / `token: xxx` 的赋值，值会被替换掉。 */
const SECRET_ASSIGNMENT_PATTERN = /\b(api[-_]?key|secret|token|password|passwd|credential|authorization|bearer)\b(\s*[:=]\s*)("?)([^\s"',;)}]{1,})/gi;

/** 形如 `sk-xxxx` / `ghp_xxxx` 的常见密钥形态。 */
const SECRET_TOKEN_PATTERN = /\b(sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g;

/** 异常栈帧（`    at Foo.bar (...)`）。 */
const STACK_FRAME_PATTERN = /^\s*at\s+\S+.*$/gm;

/** 行内异常栈片段（`at Foo.bar (/app/x.js:1:1)`），用于清理已被压平的栈信息。 */
const STACK_SEGMENT_PATTERN = /\bat\s+[A-Za-z_$][\w.$]*\s*\([^)]*\)/g;

/** 允许出现在证据里的诊断分类（与 diagnostics.mjs 的词表一致）。 */
const DIAGNOSTIC_CATEGORY_PATTERN = /^(storage|network|resource|permission|application)$/;

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 去掉控制字符并截断长度。证据里的每一个字符都来自这里，所以它同时也是
 * "证据里不会出现换行注入" 的保证。
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function sanitize(value, max = MAX_DETAIL_LENGTH) {
  const raw = text(value);
  if (!raw) return "";
  // 控制字符与换行统一替换成空格，异常栈因此无法还原成多行文本。
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * 抹掉证据里可能出现的密钥形态与异常栈帧。
 *
 * @param {string} value
 * @returns {string}
 */
function redact(value) {
  let out = String(value ?? "");
  out = out.replace(STACK_FRAME_PATTERN, " ");
  out = out.replace(STACK_SEGMENT_PATTERN, " ");
  out = out.replace(SECRET_ASSIGNMENT_PATTERN, (match, key, separator) => `${key}${separator}[redacted]`);
  out = out.replace(SECRET_TOKEN_PATTERN, "[redacted]");
  return out.replace(/\s+/g, " ").trim();
}

/**
 * 判断一个字段名是否被明确禁止。
 *
 * @param {string} name
 * @returns {boolean}
 */
function isForbiddenField(name) {
  return typeof name === "string" && FORBIDDEN_FIELD_PATTERN.test(name);
}

/**
 * 从一个对象里读取一个白名单字段，且字段名本身不得被禁止。
 *
 * @param {object} record
 * @param {string} field
 * @returns {unknown}
 */
function pick(record, field) {
  if (!record || typeof record !== "object") return undefined;
  if (isForbiddenField(field)) return undefined;
  return record[field];
}

/**
 * 构造一条证据。detail 永远经过 sanitize + redact。
 *
 * @param {string} source
 * @param {string} detail
 * @param {{at?: string, category?: string}} [extra]
 * @returns {object|null}
 */
function makeEvidence(source, detail, extra = {}) {
  // 先抹掉密钥与异常栈，再做控制字符归一与截断（顺序不能反：
  // 异常栈帧依赖行首锚点，先压平换行会失效）。
  const safeDetail = sanitize(redact(String(detail ?? "")));
  if (!safeDetail) return null;
  const evidence = { source, detail: safeDetail };
  const at = sanitize(extra?.at, 64);
  if (at) evidence.at = at;
  const category = sanitize(extra?.category, 32);
  if (category && DIAGNOSTIC_CATEGORY_PATTERN.test(category)) evidence.category = category;
  return evidence;
}

/**
 * 把审计记录变成证据。
 *
 * @param {object} entry
 * @returns {object|null}
 */
function auditEvidence(entry) {
  const method = sanitize(pick(entry, "method"), 16);
  const route = sanitize(pick(entry, "route"), 120);
  const statusCode = pick(entry, "statusCode");
  const outcome = sanitize(pick(entry, "outcome"), 24);
  const toolId = sanitize(pick(entry, "toolId"), 120);
  const risk = sanitize(pick(entry, "risk"), 24);
  const target = sanitize(pick(entry, "target"), 120);
  const parts = [];
  if (method || route) parts.push(`${method || "REQUEST"} ${route || "unknown"}`.trim());
  if (Number.isInteger(statusCode)) parts.push(`status=${statusCode}`);
  if (outcome) parts.push(`outcome=${outcome}`);
  if (toolId) parts.push(`tool=${toolId}`);
  if (risk) parts.push(`risk=${risk}`);
  if (target) parts.push(`target=${target}`);
  if (parts.length === 0) return null;
  return makeEvidence("audit", parts.join(" "), { at: sanitize(pick(entry, "at"), 64) });
}

/**
 * 把工具调用轨迹变成证据。
 *
 * 轨迹里没有参数与结果（tool-trace.mjs 有意不存它们），所以这里只会用到
 * 工具标识、风险级别、结果分类、错误分类与耗时。
 *
 * @param {object} entry
 * @returns {object|null}
 */
function traceEvidence(entry) {
  const toolId = sanitize(pick(entry, "toolId"), 120);
  const risk = sanitize(pick(entry, "risk"), 24);
  const outcome = sanitize(pick(entry, "outcome"), 24);
  const errorClass = sanitize(pick(entry, "errorClass"), 40);
  const durationMs = pick(entry, "durationMs");
  const parts = [];
  if (toolId) parts.push(`tool=${toolId}`);
  if (risk) parts.push(`risk=${risk}`);
  if (outcome) parts.push(`outcome=${outcome}`);
  if (errorClass) parts.push(`error=${errorClass}`);
  if (Number.isFinite(durationMs)) parts.push(`durationMs=${Math.max(0, Math.trunc(durationMs))}`);
  if (parts.length === 0) return null;
  return makeEvidence("trace", parts.join(" "), { at: sanitize(pick(entry, "startedAt") ?? pick(entry, "endedAt"), 64) });
}

/**
 * 把一条定时巡检变成证据。
 *
 * @param {object} check
 * @returns {object|null}
 */
function healthCheckEvidence(check) {
  const name = sanitize(pick(check, "name"), 80);
  const type = sanitize(pick(check, "type"), 40);
  const lastStatus = sanitize(pick(check, "lastStatus"), 24);
  const lastSummary = sanitize(pick(check, "lastSummary"), 120);
  const parts = [];
  parts.push(`health-check ${name || "unnamed"}`);
  if (type) parts.push(`type=${type}`);
  if (lastStatus) parts.push(`lastStatus=${lastStatus}`);
  if (lastSummary) parts.push(`summary=${lastSummary}`);
  return makeEvidence("health-check", parts.join(" "), { at: sanitize(pick(check, "lastRunAt"), 64) });
}

/**
 * 把系统快照的一段变成证据。
 *
 * 快照里的 `values` 只接受白名单键，且只接受数字与布尔值。
 *
 * @param {object} section
 * @returns {object|null}
 */
function snapshotEvidence(section) {
  const id = sanitize(pick(section, "id"), 60);
  const title = sanitize(pick(section, "title"), 80);
  const status = sanitize(pick(section, "status"), 24);
  const note = sanitize(pick(section, "note"), 120);
  const parts = [];
  parts.push(`snapshot ${title || id || "section"}`);
  if (id && title && id !== title) parts.push(`id=${id}`);
  if (status) parts.push(`status=${status}`);
  if (note) parts.push(`note=${note}`);
  const values = pick(section, "values");
  if (values && typeof values === "object" && !Array.isArray(values)) {
    for (const key of SNAPSHOT_VALUE_FIELDS) {
      if (isForbiddenField(key)) continue;
      const value = values[key];
      if (typeof value === "number" && Number.isFinite(value)) parts.push(`${key}=${value}`);
      else if (typeof value === "boolean") parts.push(`${key}=${value}`);
      else if (typeof value === "string" && /^(ok|warning|error|unavailable|unknown|degraded|healthy|failed)$/i.test(value)) {
        parts.push(`${key}=${value}`);
      }
    }
  }
  return makeEvidence("snapshot", parts.join(" "), { at: sanitize(pick(section, "capturedAt"), 64) });
}

/**
 * 读取一段快照（快照可能是 `{sections:[...]}`，也可能直接是分段数组或单个分段）。
 *
 * @param {object|Array} snapshot
 * @returns {Array<object>}
 */
function snapshotSections(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (!snapshot || typeof snapshot !== "object") return [];
  if (Array.isArray(snapshot.sections)) return snapshot.sections;
  // 单个分段（含有 id / title 之一）也按一段快照处理。
  if (typeof snapshot.id === "string" || typeof snapshot.title === "string") return [snapshot];
  return [];
}

/**
 * 把一个来源的记录数组变成证据数组。
 *
 * @param {Array} records
 * @param {Function} mapper
 * @param {number} limit
 * @returns {{items: Array<object>, truncated: boolean}}
 */
function mapSource(records, mapper, limit) {
  const items = [];
  let truncated = false;
  const list = Array.isArray(records) ? records : [];
  for (const record of list) {
    if (items.length >= limit) {
      truncated = true;
      break;
    }
    const evidence = mapper(record);
    if (!evidence) continue;
    items.push(evidence);
  }
  return { items, truncated };
}

/**
 * 收集诊断证据。
 *
 * 每一类来源独立限流（默认 50 条），所有来源合计再限一次（默认 200 条）。
 * 被截断的来源会在该来源保留的最后一条证据上打上 `truncated: true`，
 * 便于报告说明"证据不完整"。
 *
 * @param {{auditEntries?: Array, traceEntries?: Array, healthChecks?: Array, snapshots?: Array|object, now?: Date|string|number}} [input]
 * @returns {Array<{source: string, detail: string, at?: string, category?: string, truncated?: boolean}>}
 */
export function collectDiagnosticEvidence({ auditEntries = [], traceEntries = [], healthChecks = [], snapshots = [], now = null } = {}) {
  const at = now instanceof Date
    ? now.toISOString()
    : typeof now === "number"
      ? new Date(now).toISOString()
      : typeof now === "string" && now.trim()
        ? now.trim()
        : "";

  const perSource = new Map();
  perSource.set("audit", mapSource(auditEntries, auditEvidence, MAX_EVIDENCE_PER_SOURCE));
  perSource.set("trace", mapSource(traceEntries, traceEvidence, MAX_EVIDENCE_PER_SOURCE));
  perSource.set("health-check", mapSource(healthChecks, healthCheckEvidence, MAX_EVIDENCE_PER_SOURCE));

  const snapshotList = Array.isArray(snapshots) ? snapshots : [snapshots];
  const snapshotRecords = [];
  for (const snapshot of snapshotList) {
    const capturedAt = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? sanitize(pick(snapshot, "generatedAt") ?? pick(snapshot, "capturedAt"), 64)
      : "";
    for (const section of snapshotSections(snapshot)) {
      if (!section || typeof section !== "object") continue;
      snapshotRecords.push(capturedAt && !section.capturedAt
        ? { ...section, capturedAt }
        : section);
    }
  }
  perSource.set("snapshot", mapSource(snapshotRecords, snapshotEvidence, MAX_EVIDENCE_PER_SOURCE));

  const collected = [];
  for (const source of DIAGNOSTIC_EVIDENCE_SOURCES) {
    const entry = perSource.get(source);
    if (!entry) continue;
    for (const item of entry.items) {
      if (collected.length >= MAX_EVIDENCE_TOTAL) {
        const last = collected[collected.length - 1];
        if (last) last.truncated = true;
        return collected;
      }
      collected.push(item);
    }
    if (entry.truncated) {
      const lastOfSource = collected[collected.length - 1];
      if (lastOfSource && lastOfSource.source === source) lastOfSource.truncated = true;
    }
  }
  if (collected.length >= MAX_EVIDENCE_TOTAL && collected.length > 0) {
    // 总量已经触顶，报告里的证据可能不完整。
    collected[collected.length - 1].truncated = true;
  }
  if (at) {
    // 时间戳只作为兜底：证据自带 at 时以自带值为准。
    for (const item of collected) if (!item.at) item.at = at;
  }
  return collected;
}

/**
 * 证据的归一化去重键。同一来源、同一明细只保留一条。
 *
 * @param {object} evidence
 * @returns {string}
 */
function evidenceKey(evidence) {
  return `${evidence.source} ${evidence.detail}`;
}

/**
 * 把症状拆成用于匹配的片段。
 *
 * @param {string} symptom
 * @returns {Array<string>}
 */
function symptomTokens(symptom) {
  const raw = text(symptom);
  if (!raw) return [];
  const latin = raw.toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}/g) || [];
  const cjk = raw.match(/[一-鿿]{2,}/g) || [];
  return [...new Set([...latin, ...cjk])];
}

/**
 * 把收集到的证据整理成 `buildDiagnosticReport()` 需要的 evidence 形状。
 *
 *  - 相同来源、相同明细的证据只保留一条（去重）；
 *  - 与症状相关的证据排在前面，无关的排在后面（顺序稳定）；
 *  - 整体条数受 `maxEvidence` 限制，默认与总上限一致。
 *
 * @param {{auditEntries?: Array, traceEntries?: Array, healthChecks?: Array, snapshots?: Array|object, symptom?: string, maxEvidence?: number, now?: Date|string|number}} [input]
 * @returns {{evidence: Array<{source: string, detail: string}>, truncated: {bySource: object, total: boolean}, stats: {collected: number, unique: number, duplicatesRemoved: number, matched: number, limited: number}}}
 */
export function buildEvidenceBundle({
  auditEntries = [],
  traceEntries = [],
  healthChecks = [],
  snapshots = [],
  symptom = "",
  maxEvidence = MAX_EVIDENCE_TOTAL,
  now = null
} = {}) {
  const collected = collectDiagnosticEvidence({ auditEntries, traceEntries, healthChecks, snapshots, now });

  const seen = new Set();
  const unique = [];
  let duplicatesRemoved = 0;
  for (const item of collected) {
    const key = evidenceKey(item);
    if (seen.has(key)) {
      duplicatesRemoved += 1;
      continue;
    }
    seen.add(key);
    unique.push(item);
  }

  const tokens = symptomTokens(symptom);
  const isRelevant = (item) => {
    if (tokens.length === 0) return true;
    const haystack = `${item.source} ${item.detail}`.toLowerCase();
    return tokens.some(token => haystack.includes(token));
  };
  const matched = unique.filter(isRelevant);
  const others = unique.filter(item => !isRelevant(item));

  const limit = Number.isInteger(maxEvidence) && maxEvidence >= 0 ? maxEvidence : MAX_EVIDENCE_TOTAL;
  const ordered = [...matched, ...others];
  const kept = ordered.slice(0, limit);
  const limited = ordered.length - kept.length;

  const bySource = {};
  for (const source of DIAGNOSTIC_EVIDENCE_SOURCES) {
    const sourceItems = collected.filter(item => item.source === source);
    if (sourceItems.some(item => item.truncated === true)) bySource[source] = true;
  }

  return {
    // `buildDiagnosticReport()` 只需要 source 与 detail；其余字段由本模块
    // 自己用于统计，不进入报告正文。
    evidence: kept.map(item => ({ source: item.source, detail: item.detail })),
    truncated: {
      bySource,
      total: kept.length < unique.length || Object.keys(bySource).length > 0
    },
    stats: {
      collected: collected.length,
      unique: unique.length,
      duplicatesRemoved,
      matched: matched.length,
      limited
    }
  };
}

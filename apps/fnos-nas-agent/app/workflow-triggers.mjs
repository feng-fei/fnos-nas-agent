/**
 * Phase 206 — 工作流事件触发判定层（清单 W03 事件触发 / W07 幂等控制 / W10 通知去重）
 *
 * 背景：`workflow-engine.mjs` 只有依赖图、并发锁与通知钩子，它回答「工作流怎么跑」，
 * 但不回答「什么时候该跑」。本模块补上触发判定：把外部采集到的只读事实（服务状态、
 * 磁盘用量、SMART、温度、任务结果、证书剩余天数）与调用方登记的触发规则做匹配，
 * 产出「该触发哪些工作流」以及「哪些规则被拦下、为什么」。
 *
 * 设计红线（与仓库既有纯函数层一致）：
 *   - 纯函数：零 import、零 I/O、零定时器、零网络、无第三方依赖；
 *   - 不读系统时钟：`now` 必须由调用方传入；未传时内部按 epoch 0 处理，绝不回退到当前时间；
 *   - 不改写入参：规则、事实与去重状态都只读，返回值全部是新对象；
 *   - 无证据不触发：事实里缺字段、字段类型不对、条目结构不完整，一律视为「没有证据」，
 *     绝不把未知当成健康，也绝不把未知当成异常。
 */

/**
 * 六类事件触发源。顺序即对外文档顺序，调用方不要依赖它做业务排序。
 * @type {readonly string[]}
 */
export const TRIGGER_KINDS = Object.freeze([
  "service-down",
  "disk-space-low",
  "smart-warning",
  "thermal-high",
  "job-failed",
  "certificate-expiring"
]);

/** 单次判定最多接收的规则条数；超出的规则直接截断，不参与判定。 */
export const MAX_TRIGGERS = 200;

/** 默认冷却窗口：同一规则 + 同一对象在 15 分钟内只触发一次。 */
export const DEFAULT_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

/** 默认静默时段：23:00 到次日 07:00（宿主机本地时间）。 */
export const DEFAULT_QUIET_HOURS = Object.freeze({ start: "23:00", end: "07:00" });

const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_WORKFLOW_ID_LENGTH = 128;
const MAX_SUBJECT_LENGTH = 128;
const MAX_TARGET_LENGTH = 256;
const MAX_UNIT_LENGTH = 16;
const MAX_DETAIL_LENGTH = 300;
const MAX_LABEL_LENGTH = 64;
const MAX_STATE_ENTRIES = 4096;

/** 规则 id：小写字母或数字开头，后续允许 `.` `_` `-`，总长 1..64。 */
const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const QUIET_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/u;
const UNIT_PATTERN = /^[a-z%]{1,16}$/u;

function freeze(value) {
  return Object.freeze(value);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function reject(reason) {
  return freeze({ ok: false, reason });
}

/** 单行化：去掉控制字符、折叠空白，供 detail / notify label 使用。 */
function singleLine(value, max) {
  if (typeof value !== "string") return "";
  const flattened = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  return flattened.length > max ? flattened.slice(0, max) : flattened;
}

/** 触发对象标识：保留原始字符串（例如挂载点），只做安全单行化与长度上限。 */
function cleanSubject(value) {
  if (typeof value !== "string") return "";
  const flattened = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return flattened.length > MAX_SUBJECT_LENGTH ? flattened.slice(0, MAX_SUBJECT_LENGTH) : flattened;
}

function cleanTarget(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > MAX_TARGET_LENGTH ? trimmed.slice(0, MAX_TARGET_LENGTH) : trimmed;
}

/**
 * 每类触发的条件默认值。threshold 为 null 表示该类型没有数值阈值；
 * unit 与事实字段的单位绑定，避免把「天」当成「摄氏度」。
 */
const KIND_CONDITION_DEFAULTS = freeze({
  "service-down": freeze({ threshold: null, unit: null }),
  "disk-space-low": freeze({ threshold: 90, unit: "%" }),
  "smart-warning": freeze({ threshold: null, unit: null }),
  "thermal-high": freeze({ threshold: 65, unit: "celsius" }),
  "job-failed": freeze({ threshold: null, unit: null }),
  "certificate-expiring": freeze({ threshold: 30, unit: "days" })
});

/** 有阈值的类型各自允许的区间；区间外直接判为非法条件。 */
const THRESHOLD_RANGES = freeze({
  "disk-space-low": freeze([0, 100]),
  "thermal-high": freeze([-40, 200]),
  "certificate-expiring": freeze([0, 3650])
});

const DEFAULT_TARGET = null;

function normalizeCooldown(value) {
  if (value === undefined || value === null) return { ok: true, cooldownMs: DEFAULT_DEDUPE_WINDOW_MS };
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COOLDOWN_MS) {
    return { ok: false, reason: "invalid-cooldown" };
  }
  return { ok: true, cooldownMs: value };
}

function normalizeQuietHours(value) {
  if (value === undefined) return { ok: true, quietHours: DEFAULT_QUIET_HOURS };
  if (value === "off") return { ok: true, quietHours: "off" };
  if (!isPlainObject(value)) return { ok: false, reason: "invalid-quiet-hours" };
  const start = typeof value.start === "string" ? value.start.trim() : "";
  const end = typeof value.end === "string" ? value.end.trim() : "";
  if (!QUIET_TIME_PATTERN.test(start) || !QUIET_TIME_PATTERN.test(end)) {
    return { ok: false, reason: "invalid-quiet-hours" };
  }
  return { ok: true, quietHours: freeze({ start, end }) };
}

function normalizeCondition(kind, input) {
  const defaults = KIND_CONDITION_DEFAULTS[kind];
  if (input !== undefined && input !== null && !isPlainObject(input)) {
    return { ok: false, reason: "invalid-condition" };
  }
  const source = input ?? {};
  for (const key of Object.keys(source)) {
    if (!["threshold", "unit", "target"].includes(key)) return { ok: false, reason: "invalid-condition" };
  }

  let threshold = defaults.threshold;
  if (source.threshold !== undefined && source.threshold !== null) {
    const range = THRESHOLD_RANGES[kind];
    // 没有阈值的类型不接受 threshold：多给的字段通常意味着写错了 kind 或规则。
    if (!range || !Number.isFinite(source.threshold)) return { ok: false, reason: "invalid-condition" };
    if (source.threshold < range[0] || source.threshold > range[1]) {
      return { ok: false, reason: "invalid-condition" };
    }
    threshold = source.threshold;
  }

  let unit = defaults.unit;
  if (source.unit !== undefined && source.unit !== null) {
    if (defaults.unit === null || typeof source.unit !== "string") {
      return { ok: false, reason: "invalid-condition" };
    }
    const normalizedUnit = source.unit.trim().toLowerCase();
    if (!UNIT_PATTERN.test(normalizedUnit) || normalizedUnit !== defaults.unit) {
      return { ok: false, reason: "invalid-condition" };
    }
    unit = normalizedUnit;
  }

  let target = DEFAULT_TARGET;
  if (source.target !== undefined && source.target !== null) {
    if (typeof source.target !== "string") return { ok: false, reason: "invalid-condition" };
    target = cleanTarget(source.target);
    if (!target) return { ok: false, reason: "invalid-condition" };
  }

  return {
    ok: true,
    condition: freeze({ threshold, unit, target })
  };
}

/**
 * 校验并规范化一条触发规则。
 *
 * @param {object} input
 * @returns {{ok: true, rule: object} | {ok: false, reason: string}}
 *
 * reason 取值（稳定字符串，调用方可直接分支）：
 *   invalid-rule / invalid-id / unknown-kind / missing-workflow-id /
 *   invalid-workflow-id / invalid-cooldown / invalid-quiet-hours /
 *   invalid-enabled / invalid-condition
 */
export function normalizeTriggerRule(input) {
  if (!isPlainObject(input)) return reject("invalid-rule");

  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!RULE_ID_PATTERN.test(id)) return reject("invalid-id");

  if (typeof input.kind !== "string" || !TRIGGER_KINDS.includes(input.kind)) return reject("unknown-kind");

  const workflowId = typeof input.workflowId === "string" ? input.workflowId.trim() : "";
  if (!workflowId) return reject("missing-workflow-id");
  if (workflowId.length > MAX_WORKFLOW_ID_LENGTH) return reject("invalid-workflow-id");

  const cooldown = normalizeCooldown(input.cooldownMs);
  if (!cooldown.ok) return cooldown;

  const quiet = normalizeQuietHours(input.quietHours);
  if (!quiet.ok) return quiet;

  if (input.enabled !== undefined && typeof input.enabled !== "boolean") return reject("invalid-enabled");

  const condition = normalizeCondition(input.kind, input.condition);
  if (!condition.ok) return condition;

  const rule = {
    id,
    kind: input.kind,
    workflowId,
    condition: condition.condition,
    cooldownMs: cooldown.cooldownMs,
    quietHours: quiet.quietHours,
    enabled: input.enabled !== false
  };
  return freeze({ ok: true, rule: freeze(rule) });
}

/**
 * 静默时段判定。时间按宿主机本地时区解释，窗口 `[start, end)`：
 * 起点在内、终点不在内；`start > end` 表示跨午夜（例如 23:00 → 07:00）。
 *
 * - `quietHours === "off"` 表示关闭静默；
 * - 起点与终点相同视为「没有窗口」（不静默），避免把 23:00–23:00 误当全天；
 * - 非法输入或无法解析的时间一律返回 false —— 规则在 normalize 阶段已经拦住非法值。
 *
 * @param {{start: string, end: string} | "off"} quietHours
 * @param {Date | number | string} nowDate
 * @returns {boolean}
 */
export function quietHoursActive(quietHours, nowDate) {
  if (quietHours === "off") return false;
  if (!quietHours || typeof quietHours !== "object" || Array.isArray(quietHours)) return false;

  const startMatch = typeof quietHours.start === "string" ? QUIET_TIME_PATTERN.exec(quietHours.start.trim()) : null;
  const endMatch = typeof quietHours.end === "string" ? QUIET_TIME_PATTERN.exec(quietHours.end.trim()) : null;
  if (!startMatch || !endMatch) return false;

  const start = Number(startMatch[1]) * 60 + Number(startMatch[2]);
  const end = Number(endMatch[1]) * 60 + Number(endMatch[2]);
  if (start === end) return false;

  const date = resolveDate(nowDate);
  if (date === null) return false;

  const current = date.getHours() * 60 + date.getMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function resolveDate(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  }
  return null;
}

/**
 * 解析外部时钟。缺省/非法时刻返回 `{ provided: false, ms: 0 }`：
 * 内部按 epoch 0 参与算术，但因为「没有可信时钟」，判定层不会触发任何规则。
 */
function resolveClock(now) {
  if (now === undefined || now === null) return { provided: false, ms: 0 };
  const date = resolveDate(now);
  if (date === null) return { provided: false, ms: 0 };
  return { provided: true, ms: date.getTime() };
}

/**
 * 稳定去重键：`${rule.id}:${subject}`。
 * 规则 id 的字符集不含 `:`，因此这个拼接不会产生歧义。
 *
 * @param {object | string} rule
 * @param {object | string} fact 触发对象或其 subject 字符串
 * @returns {string}
 */
export function dedupeKey(rule, fact) {
  const rawId = typeof rule === "string" ? rule : rule?.id;
  const id = typeof rawId === "string" && RULE_ID_PATTERN.test(rawId.trim()) ? rawId.trim() : "unknown";
  const rawSubject = typeof fact === "string"
    ? fact
    : fact && typeof fact === "object"
      ? fact.subject
      : "";
  const subject = cleanSubject(rawSubject) || "unknown";
  return `${id}:${subject}`;
}

const NOTIFICATION_LEVELS = freeze({
  "service-down": "warning",
  "disk-space-low": "warning",
  "smart-warning": "critical",
  "thermal-high": "critical",
  "job-failed": "warning",
  "certificate-expiring": "info"
});

const NOTIFICATION_TITLES = freeze({
  "service-down": "服务停止",
  "disk-space-low": "存储空间不足",
  "smart-warning": "磁盘健康告警",
  "thermal-high": "温度过高",
  "job-failed": "任务失败",
  "certificate-expiring": "证书即将过期"
});

const NOTIFICATION_BODIES = freeze({
  "service-down": (label) => `服务\u300c${label}\u300d已停止运行，请检查。`,
  "disk-space-low": (label) => `存储\u300c${label}\u300d可用空间不足，请检查。`,
  "smart-warning": (label) => `磁盘\u300c${label}\u300d的 SMART 健康状态异常。`,
  "thermal-high": (label) => `温度区域\u300c${label}\u300d温度过高。`,
  "job-failed": (label) => `任务\u300c${label}\u300d执行失败。`,
  "certificate-expiring": (label) => `证书\u300c${label}\u300d即将过期。`
});

/**
 * 通知正文里只放「人类可读的短标签」，绝不带原始日志、命令行或文件系统路径。
 * 因此这里只取路径最后一段（`/dev/sda` → `sda`，`/vol1` → `vol1`）。
 */
function safeLabel(value) {
  if (typeof value !== "string") return "";
  const stripped = value.replace(/[\u0000-\u001f\u007f]+/gu, "").trim();
  if (!stripped) return "";
  const segments = stripped.split(/[\\/]+/u).filter(Boolean);
  const segment = segments.length > 0 ? segments[segments.length - 1] : "";
  const label = segment.slice(0, MAX_LABEL_LENGTH).trim();
  return label || "未知对象";
}

/**
 * 由一条命中记录生成通知内容。
 * level 只由 kind 决定；正文不含原始日志、命令行、文件系统路径与控制字符。
 *
 * @param {object} fired `evaluateTriggers` 的 fire 条目
 * @returns {{level: "info"|"warning"|"critical", title: string, body: string}}
 */
export function notificationFor(fired) {
  const kind = fired && typeof fired === "object" && typeof fired.kind === "string" ? fired.kind : "";
  const level = Object.hasOwn(NOTIFICATION_LEVELS, kind) ? NOTIFICATION_LEVELS[kind] : "info";
  const title = Object.hasOwn(NOTIFICATION_TITLES, kind) ? NOTIFICATION_TITLES[kind] : "工作流事件触发";
  const label = safeLabel(fired?.subject) || "未知对象";
  const body = Object.hasOwn(NOTIFICATION_BODIES, kind)
    ? NOTIFICATION_BODIES[kind](label)
    : `\u300c${label}\u300d触发了工作流事件。`;
  return { level, title, body };
}

function isTargetMatch(target, subject) {
  return target === null || target === subject;
}

/**
 * 把一类事实匹配成候选触发对象。
 * 返回 null 表示「这一类事实整个缺失/为空」——没有证据；
 * 返回 [] 表示有证据，但没有任何条目越过条件。
 */
function matchFacts(kind, rule, facts) {
  const target = rule.condition.target;
  const threshold = rule.condition.threshold;

  switch (kind) {
    case "service-down":
      return collect(facts.services, (entry) => {
        const name = cleanSubject(entry.name);
        if (!name || !isTargetMatch(target, name)) return null;
        // 只有 active 明确为 false 才算停止；缺失/未知一律不触发。
        if (entry.active !== false) return null;
        return { subject: name, detail: `服务 ${name} 处于停止状态。` };
      });
    case "disk-space-low":
      return collect(facts.disks, (entry) => {
        const mount = cleanSubject(entry.mount);
        if (!mount || !isTargetMatch(target, mount)) return null;
        // 使用率必须是有限数字；字符串、null、缺失都不是证据。
        if (!Number.isFinite(entry.usedPercent)) return null;
        if (entry.usedPercent < threshold) return null;
        return {
          subject: mount,
          detail: `挂载点 ${mount} 使用率 ${entry.usedPercent}%（阈值 ${threshold}%）。`
        };
      });
    case "smart-warning":
      return collect(facts.smart, (entry) => {
        const device = cleanSubject(entry.device);
        if (!device || !isTargetMatch(target, device)) return null;
        if (typeof entry.status !== "string") return null;
        const status = entry.status.trim().toLowerCase();
        if (status !== "warning" && status !== "failed") return null;
        return { subject: device, detail: `磁盘 ${device} 的 SMART 状态为 ${status}。` };
      });
    case "thermal-high":
      return collect(facts.thermal, (entry) => {
        const zone = cleanSubject(entry.zone);
        if (!zone || !isTargetMatch(target, zone)) return null;
        if (!Number.isFinite(entry.celsius)) return null;
        if (entry.celsius < threshold) return null;
        return {
          subject: zone,
          detail: `温度区域 ${zone} 为 ${entry.celsius}℃，达到阈值 ${threshold}℃。`
        };
      });
    case "job-failed":
      return collect(facts.jobs, (entry) => {
        const jobId = cleanSubject(entry.id);
        if (!jobId || !isTargetMatch(target, jobId)) return null;
        // 只有 ok 明确为 false 才算失败；进行中/未知不触发。
        if (entry.ok !== false) return null;
        return { subject: jobId, detail: `任务 ${jobId} 执行失败。` };
      });
    case "certificate-expiring":
      return collect(facts.certificates, (entry) => {
        const host = cleanSubject(entry.host);
        if (!host || !isTargetMatch(target, host)) return null;
        if (!Number.isFinite(entry.daysRemaining)) return null;
        if (entry.daysRemaining > threshold) return null;
        return {
          subject: host,
          detail: `证书 ${host} 剩余 ${entry.daysRemaining} 天，达到阈值 ${threshold} 天。`
        };
      });
    default:
      return null;
  }
}

function collect(source, mapper) {
  if (!Array.isArray(source) || source.length === 0) return null;
  const results = [];
  for (const entry of source) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const mapped = mapper(entry);
    if (mapped) results.push({ subject: mapped.subject, detail: singleLine(mapped.detail, MAX_DETAIL_LENGTH) });
  }
  return results;
}

function normalizeRunning(value) {
  const running = new Set();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim()) running.add(item.trim());
    }
    return running;
  }
  if (value instanceof Set) {
    for (const item of value) {
      if (typeof item === "string" && item.trim()) running.add(item.trim());
    }
    return running;
  }
  if (isPlainObject(value)) {
    for (const [key, flag] of Object.entries(value)) {
      if (flag === true && key.trim()) running.add(key.trim());
    }
  }
  return running;
}

function readLastFiredAt(value) {
  const lastFiredAt = {};
  if (value instanceof Map) {
    for (const [key, at] of value) {
      if (typeof key === "string" && key && Number.isFinite(at)) lastFiredAt[key] = at;
    }
    return lastFiredAt;
  }
  if (isPlainObject(value)) {
    for (const [key, at] of Object.entries(value)) {
      if (key && Number.isFinite(at)) lastFiredAt[key] = at;
    }
  }
  return lastFiredAt;
}

/**
 * 去重状态裁剪：只保留当前仍存在的规则名下的键（规则被删除后键自然失效），
 * 并且最多保留 MAX_STATE_ENTRIES 条，超额时丢最旧的时间戳（同时间戳按键名稳定排序）。
 */
function pruneLastFiredAt(lastFiredAt, rules) {
  const activeRuleIds = new Set(rules.map((rule) => rule.id));
  const entries = [];
  for (const [key, at] of Object.entries(lastFiredAt)) {
    const separator = key.indexOf(":");
    const ruleId = separator === -1 ? key : key.slice(0, separator);
    if (!activeRuleIds.has(ruleId)) continue;
    entries.push([key, at]);
  }

  if (entries.length <= MAX_STATE_ENTRIES) {
    const next = {};
    for (const [key, at] of entries) next[key] = at;
    return next;
  }

  const ranked = entries.slice().sort((left, right) => {
    if (left[1] !== right[1]) return left[1] - right[1];
    return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
  });
  const kept = new Set(ranked.slice(ranked.length - MAX_STATE_ENTRIES).map(([key]) => key));
  const next = {};
  for (const [key, at] of entries) {
    if (kept.has(key)) next[key] = at;
  }
  return next;
}

/**
 * 事件触发判定。
 *
 * 事实对象（字段缺失/类型不对/条目结构不完整都算「无证据」，不触发）：
 * ```js
 * {
 *   services:     [{ name, active }],        // active === false 才算停止
 *   disks:        [{ mount, usedPercent }],  // usedPercent 为有限数字且 >= 阈值
 *   smart:        [{ device, status }],      // status 为 warning/failed
 *   thermal:      [{ zone, celsius }],       // celsius 为有限数字且 >= 阈值
 *   jobs:         [{ id, ok }],              // ok === false 才算失败
 *   certificates: [{ host, daysRemaining }]  // daysRemaining 为有限数字且 <= 阈值
 * }
 * ```
 *
 * 判定顺序（每条规则）：disabled → no-facts → already-running → quiet-hours → cooldown。
 * 规则启用、事实齐全、对象越界，但仅因冷却被拦，才产生带 subject/dedupeKey 的 suppressed 条目；
 * 有证据但没有对象越界时不产生 suppressed 条目（那不是「被抑制」）。
 *
 * @param {object[]} rules
 * @param {object} [facts]
 * @param {{now?: Date|number|string, state?: object}} [options]
 * @returns {{fire: object[], suppressed: object[], state: object, truncated: boolean, notes: string[]}}
 */
export function evaluateTriggers(rules, facts, options = {}) {
  const { now, state = {} } = options ?? {};
  const clock = resolveClock(now);
  const notes = [];

  let truncated = false;
  let rawRules = [];
  if (Array.isArray(rules)) {
    truncated = rules.length > MAX_TRIGGERS;
    if (truncated) notes.push("rules-truncated");
    rawRules = truncated ? rules.slice(0, MAX_TRIGGERS) : rules;
  } else if (rules !== undefined && rules !== null) {
    notes.push("rules-invalid");
  }

  const normalizedRules = [];
  for (let index = 0; index < rawRules.length; index += 1) {
    const normalized = normalizeTriggerRule(rawRules[index]);
    if (!normalized.ok) {
      notes.push(`invalid-rule:${index}:${normalized.reason}`);
      continue;
    }
    normalizedRules.push(normalized.rule);
  }

  const normalizedState = isPlainObject(state) ? state : {};
  const running = normalizeRunning(normalizedState.running);
  const lastFiredAt = readLastFiredAt(normalizedState.lastFiredAt);

  const finish = (fire, suppressed) => ({
    fire,
    suppressed,
    state: {
      lastFiredAt: pruneLastFiredAt(lastFiredAt, normalizedRules),
      running: [...running]
    },
    truncated,
    notes
  });

  // 没有可信时钟：冷却与静默时段都无法判定，宁可一条都不触发（内部仍按 epoch 0 记账）。
  if (!clock.provided) {
    notes.push("now-missing");
    return finish([], []);
  }

  const clockDate = new Date(clock.ms);
  const factsObject = isPlainObject(facts) ? facts : null;
  const fire = [];
  const suppressed = [];

  for (const rule of normalizedRules) {
    if (!rule.enabled) {
      suppressed.push({ ruleId: rule.id, reason: "disabled" });
      continue;
    }
    if (!factsObject) {
      suppressed.push({ ruleId: rule.id, reason: "no-facts" });
      continue;
    }

    const candidates = matchFacts(rule.kind, rule, factsObject);
    if (candidates === null) {
      suppressed.push({ ruleId: rule.id, reason: "no-facts" });
      continue;
    }
    if (candidates.length === 0) continue;

    if (running.has(rule.workflowId)) {
      suppressed.push({ ruleId: rule.id, reason: "already-running" });
      continue;
    }
    if (quietHoursActive(rule.quietHours, clockDate)) {
      suppressed.push({ ruleId: rule.id, reason: "quiet-hours" });
      continue;
    }

    for (const candidate of candidates) {
      const key = dedupeKey(rule, candidate.subject);
      const last = lastFiredAt[key];
      if (last !== undefined && clock.ms - last < rule.cooldownMs) {
        suppressed.push({
          ruleId: rule.id,
          reason: "cooldown",
          subject: candidate.subject,
          dedupeKey: key
        });
        continue;
      }
      lastFiredAt[key] = clock.ms;
      fire.push({
        ruleId: rule.id,
        workflowId: rule.workflowId,
        kind: rule.kind,
        subject: candidate.subject,
        detail: candidate.detail,
        dedupeKey: key
      });
    }
  }

  return finish(fire, suppressed);
}

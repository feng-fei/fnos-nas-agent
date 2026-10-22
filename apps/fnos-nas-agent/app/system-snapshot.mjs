/**
 * System status snapshot and health scoring.
 *
 * Phase 161 implements module 02 of the user feature list: "系统信息理解与健康监控"
 * (S01–S15). The module follows one hard rule, the 数据可信原则 (data trust
 * principle):
 *
 *   1. 磁盘容量必须来自系统采集接口返回的数据，模块自己绝不猜测或估算；
 *   2. 硬盘健康必须有 SMART 支持才可断言为健康，否则只能是"未知/未采集"；
 *   3. 任何采集失败、超时或缺字段，一律显式显示为"未采集"/"接口不可用"，
 *      绝不填充默认值把未知伪装成正常。
 *
 * The module is pure logic with an injected collector: it performs no I/O, has no
 * third party dependency and never throws. Everything the caller wants to show
 * comes from `collect(sectionId)`, so the transport (HTTP, TRIM CLI, a local
 * script) is decided by the integration layer, not by this module.
 */

/** Allowed section statuses. Anything else is normalised to "unknown". */
export const SECTION_STATUSES = Object.freeze(["ok", "unknown", "unavailable"]);

/** Default weight per section, used when the caller passes no explicit weights. */
export const DEFAULT_WEIGHTS = Object.freeze({
  cpu: 1,
  memory: 1,
  storage: 2,
  network: 1,
  services: 1,
  docker: 1
});

/**
 * The default section set. The ids are fixed by the feature list, the `sIds`
 * field records which S-numbers of module 02 each section answers.
 */
export const DEFAULT_SECTIONS = Object.freeze([
  Object.freeze({ id: "cpu", title: "处理器状态", sIds: Object.freeze(["S01", "S02"]) }),
  Object.freeze({ id: "memory", title: "内存状态", sIds: Object.freeze(["S03", "S04"]) }),
  Object.freeze({ id: "storage", title: "存储与硬盘健康", sIds: Object.freeze(["S05", "S06", "S07"]) }),
  Object.freeze({ id: "network", title: "网络连通性", sIds: Object.freeze(["S08", "S09"]) }),
  Object.freeze({ id: "services", title: "系统服务状态", sIds: Object.freeze(["S10", "S11"]) }),
  Object.freeze({ id: "docker", title: "容器运行状态", sIds: Object.freeze(["S12"]) })
]);

/**
 * S-numbers of module 02 that are explicitly not collected in this phase.
 * They are reported as "未采集" so the feature matrix can show the gap instead
 * of silently pretending the capability exists.
 */
export const UNCOVERED_SIDS = Object.freeze([
  Object.freeze({ id: "S13", note: "本阶段未采集" }),
  Object.freeze({ id: "S14", note: "本阶段未采集" }),
  Object.freeze({ id: "S15", note: "本阶段未采集" })
]);

/** Minimum share of collected weight before a score is considered trustworthy. */
export const MIN_COVERAGE_RATIO = 0.34;

const STATUS_LABELS = Object.freeze({
  ok: "正常",
  unknown: "未采集",
  unavailable: "接口不可用"
});

const SECTION_TITLES = new Map(DEFAULT_SECTIONS.map(item => [item.id, item.title]));

/** Clamps a number into the 0..100 range, returns null for non finite input. */
function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(100, Math.max(0, number));
}

/** Reads a plain object property without throwing on exotic getters. */
function safeGet(owner, key) {
  if (!owner || typeof owner !== "object") return undefined;
  try {
    return owner[key];
  } catch {
    return undefined;
  }
}

/** Returns a finite number or null. */
function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Returns a plain object or an empty object. */
function toPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

/**
 * Normalises a raw status. Unknown, missing or invalid values become
 * "unknown" — they are never upgraded to "ok".
 */
function normaliseStatus(status) {
  return SECTION_STATUSES.includes(status) ? status : "unknown";
}

/**
 * Turns a raw usage percentage into a 0..100 score, with a gentle penalty for
 * very high load. Returns null when the metric is missing.
 */
function scoreUsage(usagePercent) {
  const usage = clampPercent(usagePercent);
  if (usage === null) return null;
  if (usage >= 95) return 20;
  if (usage >= 85) return 45;
  if (usage >= 70) return 75;
  return 100;
}

/**
 * Per section evaluators. Each one reads only the collected values and returns
 * `{ score, reason }` or `null` when the payload carries no usable metric.
 * A null result means "数据未采集" and the section is excluded from scoring.
 */
const EVALUATORS = {
  cpu(values) {
    const usage = toNumber(safeGet(values, "usagePercent"));
    if (usage === null) return null;
    const score = scoreUsage(usage);
    const temperature = toNumber(safeGet(values, "temperatureC"));
    let reason = `CPU 使用率 ${clampPercent(usage)}%`;
    if (temperature !== null) {
      reason += `，温度 ${temperature}°C`;
      if (temperature >= 85) return { score: Math.min(score, 30), reason: `${reason}（温度过高）` };
    }
    return { score, reason };
  },

  memory(values) {
    const used = toNumber(safeGet(values, "usedPercent"));
    if (used === null) return null;
    const total = toNumber(safeGet(values, "totalBytes"));
    const available = toNumber(safeGet(values, "availableBytes"));
    let reason = `内存使用率 ${clampPercent(used)}%`;
    if (total !== null && available !== null && total > 0) {
      reason += `（可用 ${Math.max(0, Math.round(total - available))} / ${Math.round(total)} 字节）`;
    }
    return { score: scoreUsage(used), reason };
  },

  storage(values) {
    const disks = safeGet(values, "disks");
    if (!Array.isArray(disks) || !disks.length) return null;
    let worst = null;
    let worstLabel = "";
    let smartUnknown = 0;
    let smartFailed = 0;
    for (const disk of disks) {
      const total = toNumber(safeGet(disk, "totalBytes"));
      const used = toNumber(safeGet(disk, "usedBytes"));
      if (total === null || used === null || total <= 0) continue;
      const ratio = clampPercent((used / total) * 100);
      if (ratio === null) continue;
      if (worst === null || ratio > worst) {
        worst = ratio;
        worstLabel = String(safeGet(disk, "name") || "磁盘");
      }
      const smart = safeGet(disk, "smart");
      const supported = safeGet(smart, "supported") === true;
      if (!supported) {
        smartUnknown += 1;
      } else if (safeGet(smart, "status") !== "ok") {
        smartFailed += 1;
      }
    }
    if (worst === null) return null;
    let score = scoreUsage(worst);
    let reason = `容量占用最高的磁盘 ${worstLabel} 已用 ${worst}%`;
    if (smartFailed > 0) {
      score = Math.min(score, 20);
      reason += `；SMART 检测到 ${smartFailed} 块磁盘状态异常`;
    } else if (smartUnknown > 0) {
      reason += `；硬盘健康未知/未采集（${smartUnknown} 块磁盘不支持或未返回 SMART）`;
    } else {
      reason += "；SMART 状态正常";
    }
    return { score, reason };
  },

  network(values) {
    const online = safeGet(values, "online");
    if (typeof online !== "boolean") return null;
    if (!online) return { score: 25, reason: "网络接口处于离线状态" };
    const latency = toNumber(safeGet(values, "latencyMs"));
    let reason = "网络连通正常";
    if (latency !== null) {
      reason = `网络连通正常，延迟 ${latency}ms`;
      if (latency >= 300) return { score: 60, reason: `${reason}（延迟偏高）` };
      if (latency >= 150) return { score: 85, reason };
    }
    return { score: 100, reason };
  },

  services(values) {
    const total = toNumber(safeGet(values, "total"));
    const failed = toNumber(safeGet(values, "failed"));
    if (total === null || failed === null) return null;
    if (total <= 0) return null;
    const ratio = clampPercent((failed / total) * 100);
    return {
      score: Math.max(0, 100 - ratio),
      reason: `系统服务 ${Math.round(total - failed)}/${Math.round(total)} 正常`
    };
  },

  docker(values) {
    const available = safeGet(values, "available");
    if (available === false) return null;
    const total = toNumber(safeGet(values, "containersTotal"));
    const running = toNumber(safeGet(values, "containersRunning"));
    if (total === null || running === null) return null;
    if (total <= 0) return null;
    const ratio = clampPercent((running / total) * 100);
    return {
      score: ratio,
      reason: `容器运行 ${Math.round(running)}/${Math.round(total)}`
    };
  }
};

/** Evaluates one section payload; returns null when no metric is available. */
function evaluateSection(id, values) {
  const evaluator = EVALUATORS[id];
  if (typeof evaluator !== "function") return null;
  try {
    const result = evaluator(toPlainObject(values));
    if (!result || typeof result !== "object") return null;
    const score = toNumber(safeGet(result, "score"));
    if (score === null) return null;
    return {
      score: Math.min(100, Math.max(0, score)),
      reason: typeof safeGet(result, "reason") === "string" ? safeGet(result, "reason") : "已采集"
    };
  } catch {
    return null;
  }
}

/**
 * Normalises one collected section into the snapshot shape.
 *
 * A collector that reports "ok" but returns nothing usable is downgraded to
 * "unknown" with an empty `values` object: an empty payload must never be
 * presented as a normal reading.
 */
function normaliseSection(spec, raw) {
  const payload = toPlainObject(raw);
  let status = normaliseStatus(safeGet(payload, "status"));
  let values = toPlainObject(safeGet(payload, "values"));
  let note = typeof safeGet(payload, "note") === "string" ? safeGet(payload, "note") : "";

  if (status === "ok") {
    const evaluated = evaluateSection(spec.id, values);
    if (!evaluated) {
      status = "unknown";
      values = {};
      note = note || "采集接口未返回可用数据";
    }
  } else {
    values = {};
  }

  if (status !== "ok" && !note) {
    note = status === "unavailable" ? "采集接口不可用" : "数据未采集";
  }

  return {
    id: spec.id,
    title: spec.title,
    status,
    values,
    note
  };
}

/** Resolves the effective weight of a section. */
function resolveWeight(id, weights) {
  const explicit = toNumber(safeGet(weights, id));
  if (explicit !== null && explicit > 0) return explicit;
  const fallback = toNumber(safeGet(DEFAULT_WEIGHTS, id));
  return fallback !== null && fallback > 0 ? fallback : 1;
}

/**
 * Scores a list of normalised sections.
 *
 * Sections whose status is "unknown" or "unavailable" are not weighted: they
 * are listed in the breakdown with `score: null` and the reason "数据未采集".
 * The final value is the weighted average of the collected sections multiplied
 * by the share of collected weight, so a mostly uncollected system can never
 * show a healthy score.
 *
 * @param {Array<object>} sections Normalised sections.
 * @param {object} [options]
 * @param {object} [options.weights] Weight override per section id.
 * @returns {{value: number, grade: string, breakdown: Array<object>, coverage: number}}
 */
export function scoreHealth(sections, { weights } = {}) {
  const list = Array.isArray(sections) ? sections : [];
  const breakdown = [];
  let totalWeight = 0;
  let collectedWeight = 0;
  let weightedScore = 0;

  for (const section of list) {
    const id = String(safeGet(section, "id") || "");
    const weight = resolveWeight(id, weights);
    const status = normaliseStatus(safeGet(section, "status"));
    totalWeight += weight;

    if (status !== "ok") {
      breakdown.push({
        id,
        weight,
        score: null,
        reason: status === "unavailable" ? "数据未采集（接口不可用）" : "数据未采集"
      });
      continue;
    }

    const evaluated = evaluateSection(id, safeGet(section, "values"));
    if (!evaluated) {
      breakdown.push({ id, weight, score: null, reason: "数据未采集（缺少可用指标）" });
      continue;
    }

    collectedWeight += weight;
    weightedScore += evaluated.score * weight;
    breakdown.push({ id, weight, score: evaluated.score, reason: evaluated.reason });
  }

  const coverage = totalWeight > 0 ? collectedWeight / totalWeight : 0;
  if (collectedWeight <= 0) {
    return { value: 0, grade: "unknown", breakdown, coverage: 0 };
  }

  const average = weightedScore / collectedWeight;
  const value = Math.round(average * coverage);
  let grade = "poor";
  if (coverage < MIN_COVERAGE_RATIO) grade = "unknown";
  else if (value >= 80) grade = "good";
  else if (value >= 60) grade = "fair";
  return { value, grade, breakdown, coverage: Math.round(coverage * 100) / 100 };
}

/**
 * Builds the full system snapshot.
 *
 * @param {object} [options]
 * @param {Function} [options.collect] Async collector, `collect(sectionId)`
 *   returns `{status, values?, note?}`. Any throw is turned into
 *   `status: "unavailable"`.
 * @param {Array<object>} [options.sections] Section specs, defaults to
 *   {@link DEFAULT_SECTIONS}.
 * @param {Function} [options.now] Clock, returns milliseconds.
 * @returns {Promise<object>} Snapshot with generatedAt, sections, score and the
 *   list of S-numbers that are explicitly not collected in this phase.
 */
export async function buildSystemSnapshot({ collect, sections, now } = {}) {
  const specs = Array.isArray(sections) && sections.length ? sections : DEFAULT_SECTIONS;
  const collected = [];

  for (const spec of specs) {
    const id = String(safeGet(spec, "id") || "");
    const title = typeof safeGet(spec, "title") === "string" ? safeGet(spec, "title") : SECTION_TITLES.get(id) || id;
    let raw = null;
    if (typeof collect === "function") {
      try {
        raw = await collect(id);
      } catch (error) {
        console.error(`[system-snapshot] collect(${id}) failed:`, error?.message || error);
        raw = { status: "unavailable", note: "采集接口调用失败" };
      }
    } else {
      raw = { status: "unknown", note: "未提供采集器，数据未采集" };
    }
    collected.push(normaliseSection({ id, title }, raw));
  }

  let generatedAt;
  try {
    generatedAt = new Date(typeof now === "function" ? now() : Date.now()).toISOString();
  } catch {
    generatedAt = new Date(0).toISOString();
  }

  return {
    generatedAt,
    sections: collected,
    score: scoreHealth(collected),
    uncovered: UNCOVERED_SIDS.map(item => ({ ...item }))
  };
}

/**
 * Merges the values of two snapshots (or two section lists) for incremental
 * refresh. Later data wins per key; the status of the later section wins when
 * it is present.
 *
 * @param {object|Array<object>} a Earlier payload.
 * @param {object|Array<object>} b Later payload.
 * @returns {object|Array<object>} Merged payload of the same shape.
 */
export function mergeSectionValues(a, b) {
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);

  if (aIsArray || bIsArray) {
    const left = aIsArray ? a : bIsArray ? b : [];
    const right = bIsArray ? b : aIsArray ? a : [];
    const merged = [];
    const index = new Map();
    for (const item of left) {
      const id = String(safeGet(item, "id") || "");
      const copy = { ...toPlainObject(item) };
      copy.values = { ...toPlainObject(safeGet(item, "values")) };
      index.set(id, merged.length);
      merged.push(copy);
    }
    for (const item of right) {
      const id = String(safeGet(item, "id") || "");
      const position = index.get(id);
      if (position === undefined) {
        const copy = { ...toPlainObject(item) };
        copy.values = { ...toPlainObject(safeGet(item, "values")) };
        index.set(id, merged.length);
        merged.push(copy);
        continue;
      }
      const target = merged[position];
      target.values = { ...toPlainObject(target.values), ...toPlainObject(safeGet(item, "values")) };
      const status = normaliseStatus(safeGet(item, "status"));
      if (status !== "unknown" || target.status === undefined) target.status = status;
      const note = safeGet(item, "note");
      if (typeof note === "string" && note) target.note = note;
    }
    return merged;
  }

  const left = toPlainObject(a);
  const right = toPlainObject(b);
  const merged = { ...left };
  merged.values = { ...toPlainObject(safeGet(left, "values")), ...toPlainObject(safeGet(right, "values")) };
  const status = normaliseStatus(safeGet(right, "status"));
  if (status !== "unknown" || merged.status === undefined) merged.status = status;
  const note = safeGet(right, "note");
  if (typeof note === "string" && note) merged.note = note;
  return merged;
}

/**
 * Returns the Chinese label of a section status for direct display.
 *
 * @param {string} status
 * @returns {string} "正常" / "未采集" / "接口不可用" / "未知状态"
 */
export function describeSectionStatus(status) {
  const key = normaliseStatus(status);
  return STATUS_LABELS[key] || "未知状态";
}

export default buildSystemSnapshot;

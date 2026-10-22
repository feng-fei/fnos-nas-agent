/**
 * Phase 190 — 服务状态「校验 + 解析 + 结论」层
 *
 * 能力矩阵 S10（服务状态）与 C03（查询服务状态）此前仍是 Open：仓库里既没有
 * unit 名的合法性校验，也没有把 `systemctl show <unit>` 的 Key=Value 输出变成
 * 一个可解释结论的地方。本阶段只补这一层判定逻辑，**不执行任何命令、不内置
 * 任何 fnOS unit 名单**；真正的采集器（nsenter / 只读白名单）由 Lead 后续注入，
 * 注入点就是 `collectServiceStatus({ units, run })` 的 `run` 参数。
 *
 * 红线：
 *   - **零 I/O、零依赖、零 import**：本文件不 import 任何模块，不碰 fs / 进程 / 网络；
 *   - **绝不假装 running**：缺字段、unknown、解析失败、没有采集器，一律 `unknown`；
 *   - **失败不等于运行**：`active` 之外的状态不会被折叠成 running；
 *   - **单条故障隔离**：一个 unit 抛错只污染它自己那一条记录；
 *   - **数值要有边界**：`MemoryCurrent=18446744073709551615` 是「无限制」哨兵值，
 *     它和任何超出安全整数范围的数字都必须变成 null，而不是一个巨大的数字。
 */

/** 允许的 unit 后缀（与 systemd 的常见单元类型一致）。 */
export const UNIT_SUFFIXES = Object.freeze(["service", "timer", "socket", "mount"]);

/** unit 名长度上限。 */
export const MAX_UNIT_NAME_LENGTH = 256;

/** 单次采集允许的 unit 数量上限。 */
export const MAX_UNITS = 64;

/** 采集器错误信息写入结果时的截断长度。 */
export const MAX_ERROR_MESSAGE_LENGTH = 200;

/**
 * unit 名合法形状：字母数字开头，主体允许字母数字与 `_.@:-`，
 * 以 `.service|.timer|.socket|.mount` 结尾。
 */
export const UNIT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.(service|timer|socket|mount)$/;

/** 非法 unit 名的判定理由（稳定标识，便于写入证据与日志）。 */
export const INVALID_UNIT_REASONS = Object.freeze({
  EMPTY: "empty",
  TOO_LONG: "too-long",
  BAD_SUFFIX: "bad-suffix",
  FORBIDDEN_CHAR: "forbidden-char",
  BAD_SHAPE: "bad-shape"
});

/** 服务结论取值。 */
export const VERDICTS = Object.freeze({
  RUNNING: "running",
  STOPPED: "stopped",
  FAILED: "failed",
  UNKNOWN: "unknown"
});

/** 采集条目的备注取值。 */
export const COLLECT_NOTES = Object.freeze({
  NO_COLLECTOR: "no-collector",
  COLLECTOR_FAILED: "collector-failed",
  INVALID_UNIT: "invalid-unit",
  INVALID_OUTPUT: "invalid-output"
});

/** 仅在 active 状态下才算 running 的 SubState。 */
export const RUNNING_SUB_STATES = Object.freeze(["running", "exited", "listening"]);

/** 明确表示「没在跑」的 ActiveState；失败与过渡态都不在此列。 */
export const STOPPED_ACTIVE_STATES = Object.freeze(["inactive", "dead"]);

/** `MemoryCurrent` 的「无限制」哨兵值。 */
export const MEMORY_UNLIMITED_SENTINEL = "18446744073709551615";

/**
 * 命令注入 / 路径穿越 / shell 分隔符类字符。命中就返回 `forbidden-char`，
 * 这样调用方拿到的理由能直接说明「这是危险输入」而不只是「形状不对」。
 */
const FORBIDDEN_CHAR_PATTERN = /[\s`$;|&<>\\'"*?()[\]{}!#=+,~^%\/\u0000-\u001f\u007f]/;

/** 以这些后缀结尾就算「后缀对了」，随后才由完整形状给出 bad-shape。 */
const SUFFIX_PATTERN = /\.(service|timer|socket|mount)$/;

const NOT_SET_PATTERN = /^\[not set\]$/i;

function emptyParsedFields() {
  return {
    loadState: null,
    activeState: null,
    subState: null,
    unitFileState: null,
    mainPID: null,
    memoryCurrentBytes: null,
    restartCount: null,
    result: null
  };
}

function invalidUnit(reason) {
  return { ok: false, reason };
}

/**
 * 校验 unit 名。只做字符串层面的校验：不改写、不补全、不猜测后缀。
 *
 * 判定顺序：empty → too-long → forbidden-char → bad-suffix → bad-shape。
 * 先给出「危险字符」再给出「形状不对」，是为了让审计日志能区分注入尝试与笔误。
 *
 * @param {unknown} name
 * @returns {{ ok: boolean, reason: string | null }}
 */
export function validateUnitName(name) {
  // null/undefined 归为「没给单元名」，其他非字符串是形状错误。
  if (name === undefined || name === null) {
    return invalidUnit(INVALID_UNIT_REASONS.EMPTY);
  }
  if (typeof name !== "string") {
    return invalidUnit(INVALID_UNIT_REASONS.BAD_SHAPE);
  }
  if (name.trim() === "") {
    return invalidUnit(INVALID_UNIT_REASONS.EMPTY);
  }
  if (name.length > MAX_UNIT_NAME_LENGTH) {
    return invalidUnit(INVALID_UNIT_REASONS.TOO_LONG);
  }
  if (FORBIDDEN_CHAR_PATTERN.test(name)) {
    return invalidUnit(INVALID_UNIT_REASONS.FORBIDDEN_CHAR);
  }
  if (!SUFFIX_PATTERN.test(name)) {
    return invalidUnit(INVALID_UNIT_REASONS.BAD_SUFFIX);
  }
  if (!UNIT_NAME_PATTERN.test(name)) {
    return invalidUnit(INVALID_UNIT_REASONS.BAD_SHAPE);
  }
  return { ok: true, reason: null };
}

function normalizeTextValue(raw) {
  if (raw === undefined) return null;
  const value = raw.trim();
  if (value === "" || NOT_SET_PATTERN.test(value)) return null;
  return value;
}

function normalizeIntegerValue(raw) {
  if (raw === undefined) return null;
  const value = raw.trim();
  if (value === "" || NOT_SET_PATTERN.test(value)) return null;
  // 只接受十进制非负整数：`-1`、`1.5`、`0x10` 一律视为非法，不做宽容解析。
  if (!/^\d+$/.test(value)) return null;
  if (value === MEMORY_UNLIMITED_SENTINEL) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

/**
 * 解析 `systemctl show <unit>` 的 Key=Value 多行文本。
 *
 * 只取契约里那八个键，其余行忽略；同一个键重复出现时后出现的为准。
 * `[not set]` 与空值统一变成 null；数值字段非法（含超出安全整数范围、
 * `18446744073709551615` 这种「无限制」哨兵）也是 null。
 *
 * @param {unknown} text
 * @returns {{ loadState: string|null, activeState: string|null, subState: string|null,
 *   unitFileState: string|null, mainPID: number|null, memoryCurrentBytes: number|null,
 *   restartCount: number|null, result: string|null, parsed: boolean }}
 */
export function parseSystemctlShow(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return { ...emptyParsedFields(), parsed: false };
  }

  const fields = new Map();
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (key === "") continue;
    fields.set(key, line.slice(separator + 1));
  }

  return {
    loadState: normalizeTextValue(fields.get("LoadState")),
    activeState: normalizeTextValue(fields.get("ActiveState")),
    subState: normalizeTextValue(fields.get("SubState")),
    unitFileState: normalizeTextValue(fields.get("UnitFileState")),
    mainPID: normalizeIntegerValue(fields.get("MainPID")),
    memoryCurrentBytes: normalizeIntegerValue(fields.get("MemoryCurrent")),
    restartCount: normalizeIntegerValue(fields.get("NRestarts")),
    result: normalizeTextValue(fields.get("Result")),
    parsed: fields.size > 0
  };
}

/**
 * 把一条服务记录翻译成结论。**未知永远优先于「跑着」**。
 *
 * - running：`activeState === "active"` 且 `subState` ∈ running|exited|listening；
 * - failed：`activeState === "failed"` 或 `result === "failed"`；
 * - stopped：只认明确的 `inactive` / `dead`；
 * - 其余（缺字段、unknown、activating/deactivating 等过渡态、null）→ unknown。
 *
 * 顺序按契约字面：running 判定在 failed 之前（见 docs/phase-190-service-status.md
 * 的「语义取舍」）。
 *
 * @param {unknown} record
 * @returns {"running" | "stopped" | "failed" | "unknown"}
 */
export function describeServiceVerdict(record) {
  if (record === null || typeof record !== "object") return VERDICTS.UNKNOWN;
  const { activeState, subState, result } = record;

  if (activeState === "active" && RUNNING_SUB_STATES.includes(subState)) {
    return VERDICTS.RUNNING;
  }
  if (activeState === "failed" || result === "failed") {
    return VERDICTS.FAILED;
  }
  if (STOPPED_ACTIVE_STATES.includes(activeState)) {
    return VERDICTS.STOPPED;
  }
  return VERDICTS.UNKNOWN;
}

function readField(record, key) {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readId(record, index, unit) {
  const id = readField(record, "id");
  if (id) return id;
  if (unit) return unit;
  return `record-${index + 1}`;
}

/**
 * 汇总多条服务记录。
 *
 * verdict 规则：有 failed → degraded；全部 unknown（含空列表）→ unknown；否则 healthy。
 * notes 明确指出哪几条是 unknown、哪几条缺 unit 名，以及失败的条目。
 *
 * @param {unknown} records
 * @returns {{ counts: { running: number, stopped: number, failed: number, unknown: number },
 *   items: Array<{ id: string, unit: string|null, verdict: string,
 *     activeState: string|null, subState: string|null }>,
 *   verdict: "healthy" | "degraded" | "unknown", notes: string[] }}
 */
export function summarizeServices(records) {
  if (!Array.isArray(records)) {
    throw new TypeError("summarizeServices() expects an array of service records");
  }

  const counts = { running: 0, stopped: 0, failed: 0, unknown: 0 };
  const items = [];
  const failedIds = [];
  const unknownIds = [];
  const missingUnitIds = [];
  const noteGroups = new Map();

  records.forEach((record, index) => {
    const safe = record !== null && typeof record === "object" ? record : {};
    const unit = readField(safe, "unit");
    const id = readId(safe, index, unit);
    const verdict = describeServiceVerdict(safe);
    counts[verdict] += 1;
    items.push({
      id,
      unit,
      verdict,
      activeState: readField(safe, "activeState"),
      subState: readField(safe, "subState")
    });
    if (verdict === VERDICTS.FAILED) failedIds.push(id);
    if (verdict === VERDICTS.UNKNOWN) unknownIds.push(id);
    if (!unit) missingUnitIds.push(id);
    const note = typeof safe.note === "string" ? safe.note.trim() : "";
    if (note !== "") {
      if (!noteGroups.has(note)) noteGroups.set(note, []);
      noteGroups.get(note).push(id);
    }
  });

  const notes = [];
  if (items.length === 0) {
    notes.push("no-services");
  } else {
    if (failedIds.length > 0) notes.push(`failed: ${failedIds.join(", ")}`);
    if (unknownIds.length > 0) notes.push(`unknown-verdict: ${unknownIds.join(", ")}`);
    if (missingUnitIds.length > 0) notes.push(`missing-unit: ${missingUnitIds.join(", ")}`);
    // 采集器没注入 / 采集失败 / unit 名非法 / 输出不可解析，都要在汇总里留痕，
    // 否则「unknown 但 summary 看起来 healthy」会把故障藏起来。
    for (const [note, ids] of noteGroups) {
      notes.push(`${note}: ${ids.join(", ")}`);
    }
  }

  let verdict = "healthy";
  if (counts.failed > 0) {
    verdict = "degraded";
  } else if (items.length === 0 || counts.unknown === items.length) {
    verdict = "unknown";
  }

  return { counts, items, verdict, notes };
}

function makeItem({ id, unit, note = null, error = null, reason = null, parsed = null }) {
  return {
    id,
    unit,
    verdict: VERDICTS.UNKNOWN,
    ...(parsed ?? emptyParsedFields()),
    note,
    ...(error === null ? {} : { error }),
    ...(reason === null ? {} : { reason })
  };
}

function truncateMessage(error) {
  const message = typeof error?.message === "string" && error.message !== ""
    ? error.message
    : String(error ?? "");
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/**
 * 采集服务状态。`run` 是外部注入的 `async (unit) => rawText`，本模块自身
 * 不执行任何命令；没有注入 `run` 时每条都是 unknown + note "no-collector"。
 *
 * 逐条串行采集，保持输入顺序；单条失败只影响该条（note "collector-failed"），
 * 非法 unit 名不调用采集器（note "invalid-unit"）。`units` 非数组或超过
 * MAX_UNITS 条时抛 RangeError。
 *
 * @param {unknown} options
 * @returns {Promise<{ collectedAt: string,
 *   items: Array<Record<string, unknown>>,
 *   summary: ReturnType<typeof summarizeServices> }>}
 */
export async function collectServiceStatus(options = {}) {
  const { units, run } = options ?? {};
  if (!Array.isArray(units)) {
    throw new RangeError("collectServiceStatus() requires units to be an array");
  }
  if (units.length > MAX_UNITS) {
    throw new RangeError(`collectServiceStatus() accepts at most ${MAX_UNITS} units`);
  }

  const collector = typeof run === "function" ? run : null;
  const items = [];

  for (let index = 0; index < units.length; index += 1) {
    const rawUnit = units[index];
    const unitText = typeof rawUnit === "string" ? rawUnit : null;
    const fallbackId = unitText ?? `unit-${index + 1}`;
    const validation = validateUnitName(rawUnit);

    if (!validation.ok) {
      items.push(makeItem({ id: fallbackId, unit: unitText, note: COLLECT_NOTES.INVALID_UNIT, reason: validation.reason }));
      continue;
    }
    if (!collector) {
      items.push(makeItem({ id: fallbackId, unit: unitText, note: COLLECT_NOTES.NO_COLLECTOR }));
      continue;
    }

    try {
      const rawText = await collector(rawUnit);
      const parsed = parseSystemctlShow(rawText);
      if (!parsed.parsed) {
        items.push(makeItem({ id: fallbackId, unit: unitText, note: COLLECT_NOTES.INVALID_OUTPUT, parsed }));
        continue;
      }
      items.push({
        id: fallbackId,
        unit: unitText,
        verdict: describeServiceVerdict(parsed),
        ...parsed,
        note: null
      });
    } catch (error) {
      items.push(makeItem({
        id: fallbackId,
        unit: unitText,
        note: COLLECT_NOTES.COLLECTOR_FAILED,
        error: truncateMessage(error)
      }));
    }
  }

  return {
    collectedAt: new Date().toISOString(),
    items,
    summary: summarizeServices(items)
  };
}

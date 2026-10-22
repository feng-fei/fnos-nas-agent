/**
 * Phase 193 — 温度读数规范化与分级（纯函数）
 *
 * 真机上的温度来源很杂：有的采集器吐 `45000`（毫摄氏度），有的吐 `45.5`（摄氏度），
 * 有的同一块传感器被两个来源各报一次，还有的干脆吐空行或 `N/A`。本层只做三件事：
 * 把原始读数变成可信的摄氏度、按来源去重并排序、按固定阈值给出结论。
 *
 * 红线：
 *   - **零 I/O、零依赖、零 import**：本文件不 import 任何模块，不碰文件 / 进程 / 网络，
 *     也不读取任何系统温度节点；采集由调用方完成后把数字交进来。
 *   - **绝不假装测到了**：空输入、全非法输入一律 `unknown` + `hottest: null`，
 *     不会返回 `0` 或某个默认温度来冒充读数。
 *   - **不猜**：来源名、单位、阈值都不从上下文推断；单位缺失就是非法，
 *     阈值冲突就 `TypeError`，不在运行时悄悄修正。
 *   - **有界**：可信温度限制在 ±200℃，超出视为脏数据（`null` 或 `dropped`）。
 */

/** 温度分级取值；`unknown` 表示「无法归类」，绝不等于 0℃。 */
export const THERMAL_CLASSES = Object.freeze(["cool", "normal", "warm", "hot", "unknown"]);

/** 默认告警温度（摄氏度）。 */
export const DEFAULT_WARN_C = 65;

/** 默认临界温度（摄氏度）。 */
export const DEFAULT_CRITICAL_C = 80;

/** 低于该温度归为 cool（仅在低于 warnC 的前提下生效）。 */
export const COOL_BELOW_C = 5;

/** 可信温度上限（绝对值，摄氏度）；超出视为脏数据，不参与判定。 */
export const MAX_ABSOLUTE_CELSIUS = 200;

/** 入参允许的原始单位。 */
export const RAW_UNITS = Object.freeze({
  MILLI_CELSIUS: "milliCelsius",
  CELSIUS: "celsius"
});

/** 汇总结论取值。注意 `ok` 不是 THERMAL_CLASSES 的一员：结论与单项分级是两套枚举。 */
export const THERMAL_VERDICTS = Object.freeze({
  OK: "ok",
  WARM: "warm",
  HOT: "hot",
  UNKNOWN: "unknown"
});

/** 丢弃原因（稳定标识，便于写入证据与日志）。 */
export const DROP_REASONS = Object.freeze({
  NOT_OBJECT: "not-object",
  MISSING_SOURCE: "missing-source",
  BAD_UNIT: "bad-unit",
  BAD_RAW: "bad-raw"
});

/**
 * 只接受「十进制、可带小数」的字面量。科学计数法（1e3）、十六进制（0x10）、
 * 千分位（45,000）、带单位后缀（45°C）一律拒绝：这些格式在温度节点里没有约定，
 * 强行解释就是一种猜测。
 */
const DECIMAL_PATTERN = /^[+-]?\d+(?:\.\d+)?$/;

function parseStrictDecimal(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || !DECIMAL_PATTERN.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function withinAbsoluteRange(celsius) {
  return Number.isFinite(celsius) && Math.abs(celsius) <= MAX_ABSOLUTE_CELSIUS;
}

function normalizeNegativeZero(value) {
  return Object.is(value, -0) ? 0 : value;
}

/**
 * 解析毫摄氏度读数。字符串或数字都按「毫摄氏度」解释（`"45000"` → `45`）。
 *
 * - 允许首尾空白：`"45000\n"` → `45`（sysfs 经常带换行）。
 * - 空串、非数字、非有限数（NaN / Infinity）→ `null`。
 * - 超过 ±200℃ → `null`，不做截断。
 * - `-0` 归一为 `0`，避免 `Object.is(-0, 0) === false` 引发的下游困惑。
 *
 * @param {unknown} value
 * @returns {number | null} 摄氏度
 */
export function parseMilliCelsius(value) {
  const milli = parseStrictDecimal(value);
  if (milli === null) return null;
  const celsius = milli / 1000;
  if (!withinAbsoluteRange(celsius)) return null;
  return normalizeNegativeZero(celsius);
}

/**
 * 解析摄氏度读数（内部使用，不导出）。规则与 parseMilliCelsius 一致，但不除以 1000。
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function parseCelsius(value) {
  const celsius = parseStrictDecimal(value);
  if (celsius === null || !withinAbsoluteRange(celsius)) return null;
  return normalizeNegativeZero(celsius);
}

function readSource(item) {
  if (typeof item.source !== "string") return null;
  const source = item.source.trim();
  return source === "" ? null : source;
}

/** 缺省 label 保持 `null`：不用 source 冒充 label，是否回退由展示层决定。 */
function readLabel(item) {
  if (typeof item.label !== "string") return null;
  const label = item.label.trim();
  return label === "" ? null : label;
}

function dropPositionNote(index, reason) {
  return `dropped:#${index + 1}:${reason}`;
}

/**
 * 规范化原始温度读数列表。
 *
 * 输入元素：`{ source, label?, raw, unit: "milliCelsius" | "celsius" }`。
 * 输出：`{ readings: [{ source, label, celsius }], dropped, notes }`。
 *
 * - `readings` 按 `celsius` **降序**；温度相同保持输入先后（稳定排序）。
 * - 同一 `source` 只保留最高温的一条，并记 `duplicate-source:<source>`（每个来源一条）。
 * - 无法使用的条目进入 `dropped: [{ source, reason }]`（`source` 无法识别时为 `null`），
 *   并记 `dropped:<source|#序号>:<reason>`；`reason` ∈ `DROP_REASONS`。
 * - 去重只在合法读数之间进行：先被丢弃的条目不会让后一条合法的同源读数变成「重复」。
 * - 非法条目不会中断整个规范化：单条脏数据只影响它自己。
 *
 * @param {unknown} list
 * @returns {{ readings: Array<{ source: string, label: string | null, celsius: number }>,
 *   dropped: Array<{ source: string | null, reason: string }>, notes: string[] }}
 */
export function normalizeThermalReadings(list) {
  if (!Array.isArray(list)) {
    throw new TypeError("normalizeThermalReadings() expects an array of raw thermal readings");
  }

  const bySource = new Map();
  const dropped = [];
  const notes = [];
  const noted = new Set();

  function note(text) {
    if (noted.has(text)) return;
    noted.add(text);
    notes.push(text);
  }

  list.forEach((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      dropped.push({ source: null, reason: DROP_REASONS.NOT_OBJECT });
      note(dropPositionNote(index, DROP_REASONS.NOT_OBJECT));
      return;
    }

    const source = readSource(item);
    if (source === null) {
      dropped.push({ source: null, reason: DROP_REASONS.MISSING_SOURCE });
      note(dropPositionNote(index, DROP_REASONS.MISSING_SOURCE));
      return;
    }

    if (item.unit !== RAW_UNITS.MILLI_CELSIUS && item.unit !== RAW_UNITS.CELSIUS) {
      dropped.push({ source, reason: DROP_REASONS.BAD_UNIT });
      note(`dropped:${source}:${DROP_REASONS.BAD_UNIT}`);
      return;
    }

    const celsius = item.unit === RAW_UNITS.MILLI_CELSIUS
      ? parseMilliCelsius(item.raw)
      : parseCelsius(item.raw);

    if (celsius === null) {
      dropped.push({ source, reason: DROP_REASONS.BAD_RAW });
      note(`dropped:${source}:${DROP_REASONS.BAD_RAW}`);
      return;
    }

    const label = readLabel(item);
    const existing = bySource.get(source);
    if (existing !== undefined) {
      // 同源取最高温；保留最高温条目自身的 label，不跨条目拼装。
      if (celsius > existing.celsius) {
        bySource.set(source, { source, label, celsius });
      }
      note(`duplicate-source:${source}`);
      return;
    }

    bySource.set(source, { source, label, celsius });
  });

  const readings = [...bySource.values()].sort((left, right) => right.celsius - left.celsius);
  return { readings, dropped, notes };
}

function resolveThresholds(options) {
  if (options === undefined || options === null) {
    return { warnC: DEFAULT_WARN_C, criticalC: DEFAULT_CRITICAL_C };
  }
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("summarizeThermals() options must be an object");
  }

  const warnC = options.warnC === undefined ? DEFAULT_WARN_C : options.warnC;
  const criticalC = options.criticalC === undefined ? DEFAULT_CRITICAL_C : options.criticalC;

  if (typeof warnC !== "number" || !Number.isFinite(warnC)) {
    throw new TypeError("summarizeThermals() warnC must be a finite number");
  }
  if (typeof criticalC !== "number" || !Number.isFinite(criticalC)) {
    throw new TypeError("summarizeThermals() criticalC must be a finite number");
  }
  if (warnC >= criticalC) {
    throw new TypeError("summarizeThermals() requires warnC < criticalC");
  }
  return { warnC, criticalC };
}

function resolveReadings(input) {
  if (Array.isArray(input)) return input;
  if (input !== null && typeof input === "object" && Array.isArray(input.readings)) {
    return input.readings;
  }
  throw new TypeError("summarizeThermals() expects an array of readings or { readings: [...] }");
}

function classifyCelsius(celsius, warnC, criticalC) {
  if (celsius >= criticalC) return "hot";
  if (celsius >= warnC) return "warm";
  if (celsius < COOL_BELOW_C) return "cool";
  return "normal";
}

/** 汇总只接受 normalizeThermalReadings 产出的形状：source 非空 + number 型 celsius。 */
function readNormalizedReading(item) {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
  const source = readSource(item);
  if (source === null) return null;
  if (typeof item.celsius !== "number" || !withinAbsoluteRange(item.celsius)) return null;
  return { source, label: readLabel(item), celsius: normalizeNegativeZero(item.celsius) };
}

function invalidReadingId(item, index) {
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    const source = readSource(item);
    if (source !== null) return source;
  }
  return `#${index + 1}`;
}

/**
 * 汇总温度读数并给出结论。
 *
 * 输入可以是 `readings` 数组，也可以直接是 `normalizeThermalReadings()` 的返回值
 * （自动取其中的 `readings`）。注意：规范化阶段的 `notes` 不会合并进本函数的
 * `notes`，两段信息各自负责。
 *
 * 分级（warnC / criticalC 默认 65 / 80）：
 * - `celsius >= criticalC` → `hot`；
 * - `celsius >= warnC` → `warm`；
 * - `celsius < 5` → `cool`；
 * - 其余 → `normal`。
 *
 * 结论：有 hot → `hot`；否则有 warm → `warm`；否则有可归类读数 → `ok`；
 * 一条可归类读数都没有（空数组 / 全非法）→ `unknown`，且 `hottest` 为 `null`。
 *
 * @param {unknown} input
 * @param {{ warnC?: number, criticalC?: number } | null} [options]
 * @returns {{ verdict: "ok" | "warm" | "hot" | "unknown",
 *   counts: { total: number, cool: number, normal: number, warm: number, hot: number },
 *   hottest: { source: string, label: string | null, celsius: number } | null,
 *   notes: string[] }}
 */
export function summarizeThermals(input, options = {}) {
  const { warnC, criticalC } = resolveThresholds(options);
  const list = resolveReadings(input);

  const counts = { total: 0, cool: 0, normal: 0, warm: 0, hot: 0 };
  const invalidIds = [];
  let hottest = null;

  list.forEach((item, index) => {
    const reading = readNormalizedReading(item);
    if (reading === null) {
      invalidIds.push(invalidReadingId(item, index));
      return;
    }
    const thermalClass = classifyCelsius(reading.celsius, warnC, criticalC);
    counts.total += 1;
    counts[thermalClass] += 1;
    // 并列最高温取输入顺序里最先出现的一条。
    if (hottest === null || reading.celsius > hottest.celsius) {
      hottest = reading;
    }
  });

  const notes = [];
  if (counts.total === 0) notes.push("no-readings");
  if (invalidIds.length > 0) notes.push(`invalid-reading: ${invalidIds.join(", ")}`);

  let verdict = THERMAL_VERDICTS.UNKNOWN;
  if (counts.total > 0) {
    if (counts.hot > 0) {
      verdict = THERMAL_VERDICTS.HOT;
    } else if (counts.warm > 0) {
      verdict = THERMAL_VERDICTS.WARM;
    } else {
      verdict = THERMAL_VERDICTS.OK;
    }
  }

  return { verdict, counts, hottest, notes };
}

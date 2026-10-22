/**
 * Phase 188 — 容量趋势与容量预测（能力矩阵 S14 / S17）
 *
 * 本模块只做一件事：从**已有的**容量采样里推导趋势，并给出有边界的容量结论。
 * 它不新增采集器、不读磁盘、不发命令、不写任何文件：输入是调用方已经攒下的
 * `{ at, diskUsedBytes, diskTotalBytes }` 数组，输出是纯数据。
 *
 * 核心取舍是「不猜」：
 *   - 增长率用相邻采样增量的**中位数**，不用最小二乘。单次离群采样
 *     （一次大拷贝、一次清理）不会把整条斜率带偏。
 *   - 样本不够时 `daysUntilFull` 为 `null` 且给出原因，绝不编一个天数。
 *   - 磁盘总量中途变化时只在最后一个总量相同的连续段上计算，并显式记录。
 *   - 负增长时预测值不低于当前使用量：趋势会回落，但容量结论不做乐观外推。
 */

/** 一天的毫秒数。 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 1 GiB 的字节数，只用于展示换算。 */
const BYTES_PER_GIB = 1024 ** 3;

/** 向下取整时容忍浮点误差，避免 `3 / 0.1 = 29.999999999999996` 被算成 29 天。 */
const FLOOR_TOLERANCE = 1e-9;

/** `normalizeSamples` 默认保留的采样条数（保留最新的一段）。 */
export const DEFAULT_SAMPLE_LIMIT = 500;

/** `forecastCapacity` 默认的预测天数。 */
export const DEFAULT_HORIZON_DAYS = 30;

/** 丢弃原因的固定集合；`dropped` 恒等于这四项之和。 */
export const SAMPLE_DROP_REASONS = Object.freeze([
  "badTimestamp",
  "badValue",
  "usedExceedsTotal",
  "duplicate"
]);

/** 趋势置信度的取值。 */
export const TREND_CONFIDENCES = Object.freeze(["low", "medium", "high"]);

/**
 * 不给写满天数时的原因取值。
 *
 * `horizon-not-positive` 目前是防御性枚举：`forecastCapacity` 对非正数 / 非有限的
 * `horizonDays` 直接抛 `TypeError`，所以今天不会有返回值命中它。保留它是为了让
 * 调用方在错误处理分支里有一个同名的稳定字符串，不必自己发明。
 */
export const FORECAST_REASONS = Object.freeze([
  "insufficient-samples",
  "no-growth",
  "unknown-total",
  "horizon-not-positive"
]);

/** 趋势结论的三种状态。 */
export const TREND_VERDICT_STATUSES = Object.freeze(["ok", "insufficient", "unknown"]);

/** 趋势结论里置信度的中文标注。 */
const CONFIDENCE_LABELS = Object.freeze({ low: "低", medium: "中", high: "高" });

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 只接受有限且非负的数字；其余（含数字字符串、NaN、Infinity、负数）都算非法值。 */
function toNonNegativeFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 只接受字符串时间戳；解析失败返回 null。 */
function parseTimestamp(value) {
  if (typeof value !== "string") return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function emptyDroppedReasons() {
  return { badTimestamp: 0, badValue: 0, usedExceedsTotal: 0, duplicate: 0 };
}

/**
 * 归一化 + 排序 + 去重（不含 limit）。
 *
 * 去重按**解析后的时间点**比较：`2026-01-01T00:00:00Z` 与
 * `2026-01-01T00:00:00.000Z` 视为同一个 at，保留输入中靠后的一条。
 *
 * @param {unknown} input
 * @returns {{ samples: {at: string, ms: number, diskUsedBytes: number, diskTotalBytes: number, order: number}[], droppedReasons: object }}
 */
function selectSamples(input) {
  const droppedReasons = emptyDroppedReasons();
  if (!Array.isArray(input)) return { samples: [], droppedReasons };

  const accepted = [];
  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index];
    // 非对象样本连时间都没有，按「不可解析时间」计。
    if (!isPlainObject(raw)) {
      droppedReasons.badTimestamp += 1;
      continue;
    }
    const millis = parseTimestamp(raw.at);
    if (millis === null) {
      droppedReasons.badTimestamp += 1;
      continue;
    }
    const used = toNonNegativeFinite(raw.diskUsedBytes);
    const total = toNonNegativeFinite(raw.diskTotalBytes);
    if (used === null || total === null) {
      droppedReasons.badValue += 1;
      continue;
    }
    if (used > total) {
      droppedReasons.usedExceedsTotal += 1;
      continue;
    }
    accepted.push({
      at: raw.at,
      ms: millis,
      diskUsedBytes: used,
      diskTotalBytes: total,
      order: index
    });
  }

  // 先按时间升序；同一时间点保持输入顺序（sort 稳定，再显式用 order 兜底）。
  accepted.sort((left, right) => (left.ms - right.ms) || (left.order - right.order));

  const samples = [];
  for (const sample of accepted) {
    const previous = samples[samples.length - 1];
    if (previous && previous.ms === sample.ms) {
      // 同一个 at 只留最后一条。
      samples[samples.length - 1] = sample;
      droppedReasons.duplicate += 1;
    } else {
      samples.push(sample);
    }
  }

  return { samples, droppedReasons };
}

function resolveLimit(value) {
  if (value === undefined || value === null) return DEFAULT_SAMPLE_LIMIT;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SAMPLE_LIMIT;
  return Math.max(0, Math.trunc(parsed));
}

function roundTo(value, digits) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * 相邻采样「增量 / 天数」的中位数。
 *
 * 少于两条采样时没有增量可算，返回 0（此时置信度必然是 low）。
 *
 * @param {{ms: number, diskUsedBytes: number}[]} segment 已按时间升序的同一总量段
 * @returns {number}
 */
function medianGrowth(segment) {
  const increments = [];
  for (let index = 1; index < segment.length; index += 1) {
    const days = (segment[index].ms - segment[index - 1].ms) / MS_PER_DAY;
    if (!(days > 0)) continue;
    increments.push((segment[index].diskUsedBytes - segment[index - 1].diskUsedBytes) / days);
  }
  if (increments.length === 0) return 0;
  increments.sort((left, right) => left - right);
  const middle = increments.length >> 1;
  const median = increments.length % 2 === 1
    ? increments[middle]
    : (increments[middle - 1] + increments[middle]) / 2;
  if (!Number.isFinite(median)) return 0;
  return Object.is(median, -0) ? 0 : median;
}

function confidenceFor(samplesUsed, windowDays) {
  if (samplesUsed < 3 || windowDays < 1) return "low";
  if (windowDays < 3) return "medium";
  return "high";
}

/**
 * 归一化采样窗口。
 *
 * - 丢弃不可解析的 `at`（含非字符串、缺失、非对象样本）→ `badTimestamp`；
 * - 丢弃非有限 / 非数字 / 负数的 `diskUsedBytes`、`diskTotalBytes` → `badValue`；
 * - 丢弃 `diskUsedBytes > diskTotalBytes` → `usedExceedsTotal`；
 * - 按 `at` 升序，同一时间点只留输入中最后一条 → `duplicate`；
 * - 超过 `limit` 时丢弃最旧的、保留最新的一段。**截断不计入 `dropped`**：
 *   `dropped` 只统计被判定为非法的样本，恒等于 `droppedReasons` 四项之和。
 *
 * @param {unknown} input
 * @param {{limit?: number}} [options]
 * @returns {{samples: {at: string, diskUsedBytes: number, diskTotalBytes: number}[], dropped: number, droppedReasons: {badTimestamp: number, badValue: number, usedExceedsTotal: number, duplicate: number}}}
 */
export function normalizeSamples(input, options = {}) {
  const limit = resolveLimit((options ?? {}).limit);
  const { samples, droppedReasons } = selectSamples(input);
  const kept = samples.length > limit ? samples.slice(samples.length - limit) : samples;
  const dropped = droppedReasons.badTimestamp
    + droppedReasons.badValue
    + droppedReasons.usedExceedsTotal
    + droppedReasons.duplicate;
  return {
    samples: kept.map(({ at, diskUsedBytes, diskTotalBytes }) => ({ at, diskUsedBytes, diskTotalBytes })),
    dropped,
    droppedReasons
  };
}

/**
 * 汇总趋势。
 *
 * 利率（`diskGrowthBytesPerDay`）是同一总量段内相邻采样增量的中位数。
 * **置信度按真正参与计算的采样条数与时间跨度判定**，而不是按输入总条数：
 * 总量中途变化后，被重定基丢掉的历史采样不能拿来抬高置信度。
 *
 * @param {unknown} input
 * @returns {{count: number, windowDays: number, diskGrowthBytesPerDay: number, confidence: "low"|"medium"|"high", samplesUsed: number, notes: string[]}}
 */
export function summarizeTrend(input) {
  const { samples } = selectSamples(input);
  const count = samples.length;
  const notes = [];
  let startIndex = 0;

  if (count > 0) {
    const finalTotal = samples[count - 1].diskTotalBytes;
    startIndex = count - 1;
    while (startIndex > 0 && samples[startIndex - 1].diskTotalBytes === finalTotal) startIndex -= 1;
    if (startIndex > 0) notes.push("total-changed-rebaselined");
  }

  const segment = samples.slice(startIndex);
  const samplesUsed = segment.length;
  const windowDays = samplesUsed >= 2
    ? (segment[samplesUsed - 1].ms - segment[0].ms) / MS_PER_DAY
    : 0;

  return {
    count,
    windowDays,
    diskGrowthBytesPerDay: medianGrowth(segment),
    confidence: confidenceFor(samplesUsed, windowDays),
    samplesUsed,
    notes
  };
}

/**
 * 容量预测。
 *
 * `daysUntilFull` 只在「增长率为正 + 置信度不是 low + 总量大于 0」时给出，
 * 且向下取整；否则为 `null` 并给出 `reason`。`reason` 的优先级是
 * `insufficient-samples` → `unknown-total` → `no-growth`：先承认没数据，
 * 再承认不知道总量，最后才说趋势不涨。
 *
 * 负增长时 `projectedUsedBytes` 封顶在当前使用量（不会低于当前值），
 * 并在 `assumptions` 里用中文写明这一点。
 *
 * @param {unknown} input
 * @param {{horizonDays?: number}} [options]
 * @returns {{currentUsedBytes: number, currentTotalBytes: number, usedPercent: number, projectedUsedBytes: number, projectedUsedPercent: number, daysUntilFull: number|null, confidence: "low"|"medium"|"high", assumptions: string[], reason: "insufficient-samples"|"no-growth"|"unknown-total"|"horizon-not-positive"|null}}
 */
export function forecastCapacity(input, options = {}) {
  const { horizonDays = DEFAULT_HORIZON_DAYS } = options ?? {};
  if (typeof horizonDays !== "number" || !Number.isFinite(horizonDays) || horizonDays <= 0) {
    throw new TypeError("horizonDays must be a finite positive number");
  }

  const { samples } = selectSamples(input);
  const trend = summarizeTrend(samples);
  const latest = samples[samples.length - 1];
  const currentUsedBytes = latest ? latest.diskUsedBytes : 0;
  const currentTotalBytes = latest ? latest.diskTotalBytes : 0;
  const growth = trend.diskGrowthBytesPerDay;

  const usedPercent = currentTotalBytes > 0
    ? roundTo((currentUsedBytes / currentTotalBytes) * 100, 1)
    : 0;

  // 负增长不做乐观外推：预测值不低于当前使用量。
  const projectedUsedBytes = Math.round(Math.max(currentUsedBytes, currentUsedBytes + growth * horizonDays));
  const projectedUsedPercent = currentTotalBytes > 0
    ? roundTo((projectedUsedBytes / currentTotalBytes) * 100, 1)
    : 0;

  const assumptions = [
    "线性外推：按最近采样推导的日均增长量乘以预测天数，不假设未来写入量或清理行为保持不变。"
  ];
  if (trend.samplesUsed >= 2) {
    assumptions.push(`增长率取 ${trend.samplesUsed} 条采样相邻增量的中位数，单次离群采样不会主导结论。`);
  }
  if (growth < 0) {
    assumptions.push("最近趋势为负增长（可能发生过清理或迁移），预测值按当前使用量封顶，不把下降趋势外推到未来。");
  }
  if (trend.notes.includes("total-changed-rebaselined")) {
    assumptions.push("磁盘总量中途变化：只在最后一个总量一致的连续段上计算增长率。");
  }
  if (trend.confidence === "low") {
    assumptions.push("有效采样不足 3 条或时间跨度不足 1 天，只给出当前快照，不给写满天数。");
  }
  if (!(currentTotalBytes > 0)) {
    assumptions.push("采样中的磁盘总量为 0 或缺失，无法换算剩余空间，不猜总量。");
  }

  let reason = null;
  if (trend.confidence === "low") reason = "insufficient-samples";
  else if (!(currentTotalBytes > 0)) reason = "unknown-total";
  else if (!(growth > 0)) reason = "no-growth";

  const daysUntilFull = reason === null
    ? Math.max(0, Math.floor((currentTotalBytes - currentUsedBytes) / growth + FLOOR_TOLERANCE))
    : null;

  return {
    currentUsedBytes,
    currentTotalBytes,
    usedPercent,
    projectedUsedBytes,
    projectedUsedPercent,
    daysUntilFull,
    confidence: trend.confidence,
    assumptions,
    reason
  };
}

/**
 * 给界面用的一句话结论（三态）。
 *
 * - `insufficient`：有效采样或时间跨度不够，headline 固定包含
 *   「样本不足，暂不预测」，且不给任何预测数字；
 * - `unknown`：样本够但总量未知，只报当前已用，不猜剩余空间；
 * - `ok`：给出增长量、使用率与（可算时）写满天数。
 *
 * @param {unknown} input
 * @param {{horizonDays?: number}} [options]
 * @returns {{status: "ok"|"insufficient"|"unknown", headline: string, items: {label: string, value: number|null, unit: string, note: string}[], notes: string[]}}
 */
export function buildTrendVerdict(input, options = {}) {
  const { horizonDays = DEFAULT_HORIZON_DAYS } = options ?? {};
  const { samples } = selectSamples(input);
  const trend = summarizeTrend(samples);
  // 预测同时负责校验 horizonDays：非法值在这里抛 TypeError，不会产出半成品结论。
  const forecast = forecastCapacity(samples, { horizonDays });

  let status = "ok";
  if (trend.confidence === "low") status = "insufficient";
  else if (!(forecast.currentTotalBytes > 0)) status = "unknown";

  const notes = [
    `有效采样 ${trend.count} 条，参与趋势计算 ${trend.samplesUsed} 条，覆盖 ${roundTo(trend.windowDays, 1)} 天。`,
    `置信度 ${CONFIDENCE_LABELS[trend.confidence]}。`
  ];
  if (trend.notes.includes("total-changed-rebaselined")) {
    notes.push("磁盘总量中途变化，只在最后一个总量一致的连续段上计算。");
  }

  const growthGiB = roundTo(trend.diskGrowthBytesPerDay / BYTES_PER_GIB, 2);
  const usedGiB = roundTo(forecast.currentUsedBytes / BYTES_PER_GIB, 1);
  const totalGiB = roundTo(forecast.currentTotalBytes / BYTES_PER_GIB, 1);

  if (status === "insufficient") {
    notes.push("样本不足时不给写满天数，也不给预测数字。");
    return {
      status,
      headline: "样本不足，暂不预测：有效采样或时间跨度不够，先继续积累历史数据。",
      items: [
        {
          label: "有效采样",
          value: trend.count,
          unit: "条",
          note: "已去掉非法时间、非法数值、重复点与使用量超过总量的点"
        },
        {
          label: "时间跨度",
          value: roundTo(trend.windowDays, 1),
          unit: "天",
          note: "至少需要 3 条有效采样且跨度不少于 1 天"
        }
      ],
      notes
    };
  }

  if (status === "unknown") {
    notes.push("总量未知时只报当前已用，不推算使用率与写满天数。");
    return {
      status,
      headline: "磁盘总量未知，暂不判断剩余空间：采样里的总量缺失或为零，不猜总量。",
      items: [
        { label: "当前已用", value: usedGiB, unit: "GiB", note: "来自最后一条有效采样" },
        { label: "磁盘总量", value: null, unit: "GiB", note: "采样中的总量为 0 或缺失，不猜" }
      ],
      notes
    };
  }

  let headline;
  if (forecast.daysUntilFull !== null) {
    headline = forecast.daysUntilFull === 0
      ? `按最近 ${roundTo(trend.windowDays, 1)} 天的趋势，剩余空间不足 1 天就会写满。`
      : `按最近 ${roundTo(trend.windowDays, 1)} 天的趋势，磁盘每天约增长 ${growthGiB} GiB，约 ${forecast.daysUntilFull} 天后写满。`;
  } else if (trend.diskGrowthBytesPerDay < 0) {
    headline = `按最近 ${roundTo(trend.windowDays, 1)} 天的趋势，磁盘使用量在下降（可能发生过清理），按当前趋势不会写满。`;
  } else {
    headline = `按最近 ${roundTo(trend.windowDays, 1)} 天的趋势，磁盘使用量基本持平，按当前趋势不会写满。`;
  }

  return {
    status,
    headline,
    items: [
      {
        label: "每日增长",
        value: growthGiB,
        unit: "GiB/天",
        note: `相邻采样增量的中位数，参与计算 ${trend.samplesUsed} 条`
      },
      {
        label: "使用率",
        value: forecast.usedPercent,
        unit: "%",
        note: `${usedGiB} GiB / ${totalGiB} GiB`
      },
      {
        label: "预计写满",
        value: forecast.daysUntilFull,
        unit: "天",
        note: forecast.daysUntilFull === null ? "增长率为零或为负，不预测写满" : "按当前增速线性外推"
      }
    ],
    notes
  };
}

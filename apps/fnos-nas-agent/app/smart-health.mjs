/**
 * Phase 192 — SMART 盘健康解析层（纯函数）
 *
 * 能力矩阵 S06（磁盘健康 / SMART）此前仍是 Open：仓库里只有「SMART 缺失 → 未知」
 * 这样的状态位，没有把 `smartctl -i` / `smartctl -A` 的文本变成结构化字段与可解释
 * 结论的地方。本阶段只补这一层判定逻辑，**不执行任何命令、不读任何设备节点**；
 * 真正的采集器（smartctl 只读调用、超时、`-d` 类型选择、权限失败处理）由 Lead 后续注入。
 *
 * 红线：
 *   - 零 I/O、零依赖、零外部模块引用：本文件不引用任何模块，不碰文件系统 / 子进程 / 网络；
 *   - **绝不凭空写 ok**：SMART 不可用、没有属性、输入不可解析、判定所需属性缺失
 *     （包括解析失败被跳过的行），结论都只能是 unknown；
 *   - **只认白名单字段**：`-i` 文本里没有出现的字段一律 null，绝不从别的字段猜；
 *   - **原始值不做有损转换**：RAW_VALUE 保留原文，`44 (0 18 0 0 0)` 不会被截成数字；
 *   - **判定规则全部是导出的常量**：审查时先看常量，再看实现。
 */

/** SMART 是否可用。 */
export const SMART_SUPPORT = Object.freeze({
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable"
});

/** 允许从 `smartctl -i` 文本映射的字段白名单（顺序即 parseSmartInfo 返回的字段顺序）。 */
export const SMART_INFO_FIELDS = Object.freeze([
  "modelFamily",
  "model",
  "serialNumber",
  "firmwareVersion",
  "rotationRate",
  "powerOnHours",
  "smartSupport"
]);

/** 健康结论取值。 */
export const SMART_VERDICTS = Object.freeze({
  OK: "ok",
  WARNING: "warning",
  FAILED: "failed",
  UNKNOWN: "unknown"
});

/**
 * 结论优先级（越靠前越严重）。
 *
 * unknown 只压过 ok：当输入自相矛盾（例如 `-i` 说 SMART 不可用，却仍然给了属性表
 * 且 RAW_VALUE > 0）时，宁可报出已经出现的真实告警，也不把它降级成 unknown
 * 从而隐藏故障；但反过来，只要存在 unknown 的理由，就绝不写 ok。
 */
export const VERDICT_PRECEDENCE = Object.freeze(["failed", "warning", "unknown", "ok"]);

/** finding 的严重级。 */
export const SMART_SEVERITIES = Object.freeze({
  WARNING: "warning",
  FAILED: "failed"
});

/** finding 的稳定 code。 */
export const SMART_FINDING_CODES = Object.freeze({
  REALLOCATED_SECTORS: "reallocated-sectors",
  REPORTED_UNCORRECTABLE: "reported-uncorrectable",
  CURRENT_PENDING_SECTORS: "current-pending-sectors",
  OFFLINE_UNCORRECTABLE: "offline-uncorrectable",
  UDMA_CRC_ERRORS: "udma-crc-errors",
  TEMPERATURE_HIGH: "temperature-high",
  TEMPERATURE_CRITICAL: "temperature-critical",
  ATTRIBUTE_FAILED: "attribute-failed"
});

/** note 的稳定前缀；带值的 note 形如 `missing-attribute:197`。 */
export const SMART_NOTE_CODES = Object.freeze({
  INVALID_INPUT: "invalid-input",
  SMART_SUPPORT_UNKNOWN: "smart-support-unknown",
  SMART_SUPPORT_UNAVAILABLE: "smart-support-unavailable",
  NO_ATTRIBUTES: "no-attributes",
  INVALID_ATTRIBUTE_ENTRY: "invalid-attribute-entry",
  SKIPPED_LINES: "skipped-attribute-lines",
  MISSING_ATTRIBUTE: "missing-attribute",
  UNREADABLE_ATTRIBUTE: "unreadable-attribute"
});

/** 介质级错误计数属性：RAW_VALUE > 0 即 warning。 */
export const MEDIA_ERROR_ATTRIBUTE_IDS = Object.freeze([5, 187, 197, 198]);

/** UDMA CRC 错误属性：RAW_VALUE > 0 即 warning（线材 / 接口）。 */
export const CRC_ERROR_ATTRIBUTE_ID = 199;

/** 温度属性（摄氏度）。 */
export const TEMPERATURE_ATTRIBUTE_ID = 194;

/** 温度阈值：> 55 告警，> 65 失败。 */
export const TEMPERATURE_WARNING_CELSIUS = 55;
export const TEMPERATURE_FAILED_CELSIUS = 65;

/** 判定所需的属性；缺任何一条都不能给出 ok。 */
export const REQUIRED_ATTRIBUTE_IDS = Object.freeze([5, 187, 194, 197, 198, 199]);

/** ATA 属性 ID 与归一化值的边界。 */
export const MIN_ATTRIBUTE_ID = 1;
export const MAX_ATTRIBUTE_ID = 255;
export const MAX_NORMALIZED_VALUE = 255;

/** 证据文本的长度上限，避免把设备输出原样塞进结论。 */
export const MAX_ATTRIBUTE_NAME_LENGTH = 64;
export const MAX_FAILURE_TEXT_LENGTH = 40;
export const MAX_DETAIL_TEXT_LENGTH = 160;

/**
 * `smartctl -i` 里可映射的标签（小写、空白压缩后比较）→ 返回字段。
 *
 * 只列真正能对上的标签：`Device Model`（ATA）与 `Model Number`（NVMe）都映射到
 * `model`，但 `modelFamily` 与 `model` 互不回填。
 */
const INFO_LABELS = Object.freeze({
  "model family": "modelFamily",
  "device model": "model",
  "model number": "model",
  "serial number": "serialNumber",
  "firmware version": "firmwareVersion",
  "rotation rate": "rotationRate",
  "power on hours": "powerOnHours"
});

/** `smartctl -i` 里 SMART 能力行；可能连续出现两行（Available + Enabled）。 */
const SMART_SUPPORT_LABEL = "smart support is";

/** 形如属性数据行：行首是最多三位的数字 + 空白。用于区分「跳过」与「忽略」。 */
const DATA_LIKE_LINE_PATTERN = /^\s*\d{1,3}\s/;

const ATTRIBUTE_ID_PATTERN = /^\d{1,3}$/;
const NORMALIZED_VALUE_PATTERN = /^\d{1,3}$/;
const FLAG_PATTERN = /^0x[0-9a-fA-F]{1,8}$/;
const ATTRIBUTE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:@#-]*$/;
const ATTRIBUTE_TYPE_PATTERN = /^(pre-fail|old_age|unknown)$/i;
const ATTRIBUTE_UPDATED_PATTERN = /^[A-Za-z]+$/;
const WHEN_FAILED_PATTERN = /^[A-Za-z_-]+$/;

/** 属性行最少 token 数：ID#、NAME、FLAG、VALUE、WORST、THRESH、TYPE、UPDATED、WHEN_FAILED、RAW。 */
const MIN_ATTRIBUTE_ROW_TOKENS = 10;

/** finding 排序时的严重级次序（failed 在前，便于人读）。 */
const SEVERITY_RANK = new Map([
  [SMART_SEVERITIES.FAILED, 0],
  [SMART_SEVERITIES.WARNING, 1]
]);

/** 介质级属性 → finding code 与解释。 */
const MEDIA_ERROR_FINDINGS = new Map([
  [5, { code: SMART_FINDING_CODES.REALLOCATED_SECTORS, reason: "已重映射扇区数大于 0，介质可能开始出现坏道" }],
  [187, { code: SMART_FINDING_CODES.REPORTED_UNCORRECTABLE, reason: "控制器上报过不可纠正错误" }],
  [197, { code: SMART_FINDING_CODES.CURRENT_PENDING_SECTORS, reason: "存在待映射的疑似坏扇区" }],
  [198, { code: SMART_FINDING_CODES.OFFLINE_UNCORRECTABLE, reason: "离线自检发现不可纠正扇区" }]
]);

function clipText(value, max) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * 拆出 `Label: value`。取第一个冒号；没有冒号、或标签为空的行返回 null。
 */
function splitLabel(line) {
  const separator = line.indexOf(":");
  if (separator <= 0) return null;
  const label = line.slice(0, separator).trim();
  if (label === "") return null;
  return {
    label: label.toLowerCase().replace(/\s+/g, " "),
    value: line.slice(separator + 1).trim()
  };
}

/** 千分位数字（`1,234`）→ 安全整数；其他形态一律 null，不做宽容解析。 */
function parseIntegerWithThousands(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/,/g, "").trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * 合并 `SMART support is:` 的多行取值。
 *
 * 真机上常见两行：`Available - device has SMART capability.` 紧接 `Enabled`。
 * `Disabled` 表示设备有 SMART 但被关掉、属性读不到，对「能不能拿属性」这件事
 * 等价于不可用；无法识别的措辞（如 `Ambiguous ...`）返回 null，绝不猜成可用。
 */
function classifySmartSupport(values) {
  let available = false;
  let unavailable = false;
  for (const value of values) {
    const text = value.toLowerCase();
    if (text.startsWith("unavailable")) {
      unavailable = true;
    } else if (text.startsWith("disabled")) {
      unavailable = true;
    } else if (text.startsWith("available")) {
      available = true;
    } else if (text.startsWith("enabled")) {
      available = true;
    }
  }
  if (unavailable) return SMART_SUPPORT.UNAVAILABLE;
  if (available) return SMART_SUPPORT.AVAILABLE;
  return null;
}

function readBoundedInteger(text, min, max) {
  if (typeof text !== "string" || !NORMALIZED_VALUE_PATTERN.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

/**
 * RAW_VALUE 的前导整数：`44 (0 18 0 0 0)` → 44，`0` → 0，`---` → null。
 *
 * 只取行首的十进制整数，不在括号里找最大值、不做单位换算；取不到就返回 null，
 * 由调用方按「没有可用数值」处理。
 */
function readRawNumber(raw) {
  if (typeof raw === "number") return Number.isSafeInteger(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const match = /^\s*(-?\d+)/.exec(raw);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function readSkippedLines(attributes) {
  if (!Array.isArray(attributes)) return 0;
  const skipped = attributes.skipped;
  return Number.isInteger(skipped) && skipped > 0 ? skipped : 0;
}

/**
 * 解析一条 ATA 属性行；列位置或取值不合法时返回 null（由调用方计入 skipped）。
 */
function parseAttributeRow(line) {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < MIN_ATTRIBUTE_ROW_TOKENS) return null;

  const id = readBoundedInteger(tokens[0], MIN_ATTRIBUTE_ID, MAX_ATTRIBUTE_ID);
  if (id === null) return null;

  const name = tokens[1];
  if (name.length > MAX_ATTRIBUTE_NAME_LENGTH || !ATTRIBUTE_NAME_PATTERN.test(name)) return null;
  if (!FLAG_PATTERN.test(tokens[2])) return null;

  const value = readBoundedInteger(tokens[3], 0, MAX_NORMALIZED_VALUE);
  const worst = readBoundedInteger(tokens[4], 0, MAX_NORMALIZED_VALUE);
  const threshold = readBoundedInteger(tokens[5], 0, MAX_NORMALIZED_VALUE);
  if (value === null || worst === null || threshold === null) return null;

  if (!ATTRIBUTE_TYPE_PATTERN.test(tokens[6])) return null;
  if (!ATTRIBUTE_UPDATED_PATTERN.test(tokens[7])) return null;

  const whenFailedText = tokens[8];
  if (whenFailedText !== "-" && !WHEN_FAILED_PATTERN.test(whenFailedText)) return null;

  return {
    id,
    name,
    value,
    worst,
    threshold,
    raw: tokens.slice(9).join(" ").trim(),
    whenFailed: whenFailedText === "-" ? null : whenFailedText
  };
}

/**
 * 解析 `smartctl -i` 风格文本。
 *
 * @param {unknown} text
 * @returns {{ modelFamily: string|null, model: string|null, serialNumber: string|null,
 *   firmwareVersion: string|null, rotationRate: string|null, powerOnHours: number|null,
 *   smartSupport: string|null, parsed: boolean }}
 */
export function parseSmartInfo(text) {
  const info = {
    modelFamily: null,
    model: null,
    serialNumber: null,
    firmwareVersion: null,
    rotationRate: null,
    powerOnHours: null,
    smartSupport: null,
    parsed: false
  };
  if (typeof text !== "string" || text.trim() === "") return info;

  const supportValues = [];

  for (const line of text.split(/\r?\n/)) {
    const pair = splitLabel(line);
    if (pair === null || pair.value === "") continue;

    if (pair.label === SMART_SUPPORT_LABEL) {
      supportValues.push(pair.value);
      info.parsed = true;
      continue;
    }

    const field = INFO_LABELS[pair.label];
    if (field === undefined) continue;

    info.parsed = true;
    if (field === "powerOnHours") {
      info.powerOnHours = parseIntegerWithThousands(pair.value);
    } else {
      info[field] = pair.value;
    }
  }

  info.smartSupport = classifySmartSupport(supportValues);
  return info;
}

/**
 * 解析 `smartctl -A` 的 ATA 属性表。
 *
 * 返回按输出顺序排列的 `{ id, name, value, worst, threshold, raw, whenFailed }` 数组；
 * RAW_VALUE 保留原文（字符串），`when_failed` 为 `-` 时是 null。
 *
 * 无法解析的数据行会被跳过，但计数：数组带一个不可枚举的 `skipped` 属性。
 * 不可枚举是刻意的——这样数组在 deepEqual / JSON / 展开等场景里仍是一个纯数组，
 * 需要计数时直接读 `rows.skipped`（先 spread 会丢掉它）。
 *
 * @param {unknown} text
 * @returns {Array<{ id: number, name: string, value: number, worst: number,
 *   threshold: number, raw: string, whenFailed: string|null }>}
 */
export function parseSmartAttributes(text) {
  const rows = [];
  let skipped = 0;

  if (typeof text === "string" && text.trim() !== "") {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      // 表头、smartctl 的 === 分节线、banner 等都不是数据行，忽略且不计数。
      if (line.includes("ATTRIBUTE_NAME")) continue;
      if (line.trimStart().startsWith("===")) continue;

      const dataLike = DATA_LIKE_LINE_PATTERN.test(line);
      const record = parseAttributeRow(line);
      if (record !== null) {
        rows.push(record);
      } else if (dataLike) {
        skipped += 1;
      }
    }
  }

  Object.defineProperty(rows, "skipped", {
    value: skipped,
    enumerable: false,
    configurable: true
  });
  return rows;
}

/**
 * 把一条由调用方传入的属性记录规整成内部形状；不合法返回 null。
 */
function readAttributeRecord(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;

  const id = entry.id;
  if (!Number.isInteger(id) || id < MIN_ATTRIBUTE_ID || id > MAX_ATTRIBUTE_ID) return null;

  const name = typeof entry.name === "string" && entry.name.trim() !== ""
    ? clipText(entry.name, MAX_ATTRIBUTE_NAME_LENGTH)
    : `attribute-${id}`;

  const rawText = typeof entry.raw === "string"
    ? entry.raw
    : (typeof entry.raw === "number" && Number.isFinite(entry.raw) ? String(entry.raw) : null);

  const failureText = typeof entry.whenFailed === "string" ? entry.whenFailed.trim() : "";

  return {
    id,
    name,
    rawValue: readRawNumber(rawText),
    whenFailed: failureText === "" || failureText === "-"
      ? null
      : clipText(failureText, MAX_FAILURE_TEXT_LENGTH)
  };
}

function makeFinding(code, severity, attributeId, detail) {
  return {
    code,
    severity,
    attributeId,
    detail: clipText(detail, MAX_DETAIL_TEXT_LENGTH)
  };
}

/**
 * 单条属性的判定：when_failed、介质错误计数、CRC、温度。
 * 温度同时超过 55 与 65 时只报温度失败，不重复报告警。
 */
function collectAttributeFindings(record, findings) {
  const { id, name, rawValue, whenFailed } = record;

  if (whenFailed !== null) {
    findings.push(makeFinding(
      SMART_FINDING_CODES.ATTRIBUTE_FAILED,
      SMART_SEVERITIES.FAILED,
      id,
      `${name} when_failed=${whenFailed}（smartctl 已判定该属性失败）`
    ));
  }

  if (rawValue === null) return;

  const media = MEDIA_ERROR_FINDINGS.get(id);
  if (media !== undefined && rawValue > 0) {
    findings.push(makeFinding(
      media.code,
      SMART_SEVERITIES.WARNING,
      id,
      `${name} raw=${rawValue}（${media.reason}）`
    ));
  }

  if (id === CRC_ERROR_ATTRIBUTE_ID && rawValue > 0) {
    findings.push(makeFinding(
      SMART_FINDING_CODES.UDMA_CRC_ERRORS,
      SMART_SEVERITIES.WARNING,
      id,
      `${name} raw=${rawValue}（UDMA CRC 错误通常是 SATA 线材或接口接触问题，未必是盘体介质）`
    ));
  }

  if (id === TEMPERATURE_ATTRIBUTE_ID) {
    if (rawValue > TEMPERATURE_FAILED_CELSIUS) {
      findings.push(makeFinding(
        SMART_FINDING_CODES.TEMPERATURE_CRITICAL,
        SMART_SEVERITIES.FAILED,
        id,
        `${name} raw=${rawValue}（温度超过 ${TEMPERATURE_FAILED_CELSIUS}°C 严重阈值，应立即处理散热）`
      ));
    } else if (rawValue > TEMPERATURE_WARNING_CELSIUS) {
      findings.push(makeFinding(
        SMART_FINDING_CODES.TEMPERATURE_HIGH,
        SMART_SEVERITIES.WARNING,
        id,
        `${name} raw=${rawValue}（温度超过 ${TEMPERATURE_WARNING_CELSIUS}°C 告警阈值）`
      ));
    }
  }
}

/**
 * 稳定排序：属性 id 升序 → failed 先于 warning → code 字典序。
 */
function compareFindings(left, right) {
  const leftId = Number.isInteger(left.attributeId) ? left.attributeId : MAX_ATTRIBUTE_ID + 1;
  const rightId = Number.isInteger(right.attributeId) ? right.attributeId : MAX_ATTRIBUTE_ID + 1;
  if (leftId !== rightId) return leftId - rightId;

  const leftRank = SEVERITY_RANK.get(left.severity) ?? 9;
  const rightRank = SEVERITY_RANK.get(right.severity) ?? 9;
  if (leftRank !== rightRank) return leftRank - rightRank;

  if (left.code === right.code) return 0;
  return left.code < right.code ? -1 : 1;
}

function pickVerdict(candidates) {
  for (const verdict of VERDICT_PRECEDENCE) {
    if (candidates.has(verdict)) return verdict;
  }
  return SMART_VERDICTS.UNKNOWN;
}

/**
 * 汇总 SMART 健康结论。
 *
 * 判定顺序：failed → warning → unknown → ok。`ok` 只在「SMART 明确可用 + 判定所需的
 * 六个属性都在且 RAW_VALUE 可读 + 没有任何 finding」时出现；其余情况一律不写 ok。
 *
 * @param {unknown} input
 * @returns {{ verdict: "ok"|"warning"|"failed"|"unknown",
 *   findings: Array<{ code: string, severity: string, attributeId: number, detail: string }>,
 *   notes: string[] }}
 */
export function summarizeSmartHealth(input = {}) {
  const record = input !== null && typeof input === "object" && !Array.isArray(input) ? input : null;
  if (record === null) {
    return {
      verdict: SMART_VERDICTS.UNKNOWN,
      findings: [],
      notes: [`${SMART_NOTE_CODES.INVALID_INPUT}:arguments`]
    };
  }

  const notes = [];
  const candidates = new Set();
  const findings = [];

  const info = record.info;
  const infoIsObject = info !== null && typeof info === "object" && !Array.isArray(info);

  if (!infoIsObject) {
    notes.push(`${SMART_NOTE_CODES.INVALID_INPUT}:info`);
    candidates.add(SMART_VERDICTS.UNKNOWN);
  } else if (info.parsed === false) {
    notes.push(`${SMART_NOTE_CODES.INVALID_INPUT}:info-unparsable`);
    candidates.add(SMART_VERDICTS.UNKNOWN);
  } else {
    const support = info.smartSupport;
    if (support === SMART_SUPPORT.AVAILABLE) {
      // 明确可用：继续看属性。
    } else if (support === SMART_SUPPORT.UNAVAILABLE) {
      notes.push(SMART_NOTE_CODES.SMART_SUPPORT_UNAVAILABLE);
      candidates.add(SMART_VERDICTS.UNKNOWN);
    } else {
      // 缺失、`Ambiguous`、或其他无法识别的取值：不知道就说不知道。
      notes.push(SMART_NOTE_CODES.SMART_SUPPORT_UNKNOWN);
      candidates.add(SMART_VERDICTS.UNKNOWN);
    }
  }

  const attributes = record.attributes;
  const list = Array.isArray(attributes) ? attributes : null;
  if (list === null) {
    notes.push(`${SMART_NOTE_CODES.INVALID_INPUT}:attributes`);
    candidates.add(SMART_VERDICTS.UNKNOWN);
  }

  const records = [];
  let invalidEntries = 0;
  if (list !== null) {
    for (const entry of list) {
      const parsed = readAttributeRecord(entry);
      if (parsed === null) {
        invalidEntries += 1;
      } else {
        records.push(parsed);
      }
    }
  }

  let coverageComplete = true;

  if (invalidEntries > 0) {
    notes.push(`${SMART_NOTE_CODES.INVALID_ATTRIBUTE_ENTRY}:${invalidEntries}`);
    coverageComplete = false;
  }

  const skipped = readSkippedLines(list);
  if (skipped > 0) {
    // 被跳过的可能正是出错的那一条，所以它让覆盖度不完整，绝不写成 ok。
    notes.push(`${SMART_NOTE_CODES.SKIPPED_LINES}:${skipped}`);
    coverageComplete = false;
  }

  if (list !== null && list.length === 0) {
    notes.push(SMART_NOTE_CODES.NO_ATTRIBUTES);
    candidates.add(SMART_VERDICTS.UNKNOWN);
    coverageComplete = false;
  }

  const observedRaw = new Map();
  for (const attribute of records) {
    if (!observedRaw.has(attribute.id)) {
      observedRaw.set(attribute.id, attribute.rawValue);
    } else if (observedRaw.get(attribute.id) === null && attribute.rawValue !== null) {
      observedRaw.set(attribute.id, attribute.rawValue);
    }
  }

  if (records.length > 0) {
    for (const id of REQUIRED_ATTRIBUTE_IDS) {
      if (!observedRaw.has(id)) {
        notes.push(`${SMART_NOTE_CODES.MISSING_ATTRIBUTE}:${id}`);
        coverageComplete = false;
      } else if (observedRaw.get(id) === null) {
        notes.push(`${SMART_NOTE_CODES.UNREADABLE_ATTRIBUTE}:${id}`);
        coverageComplete = false;
      }
    }
  }

  for (const attribute of records) {
    collectAttributeFindings(attribute, findings);
  }
  findings.sort(compareFindings);

  if (findings.some(finding => finding.severity === SMART_SEVERITIES.FAILED)) {
    candidates.add(SMART_VERDICTS.FAILED);
  } else if (findings.length > 0) {
    candidates.add(SMART_VERDICTS.WARNING);
  }

  if (coverageComplete && candidates.size === 0) {
    candidates.add(SMART_VERDICTS.OK);
  }

  return {
    verdict: pickVerdict(candidates),
    findings,
    notes: [...new Set(notes)]
  };
}

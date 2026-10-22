/**
 * Phase 207 — 日志证据化层（纯函数）
 *
 * 目标：把调用方已经读到的日志文本，变成可排序、可引用、已脱敏的证据条目，
 * 供 `app/diagnostic-evidence.mjs` 的诊断证据源消费（清单 D02 日志关联 / S13 系统事件）。
 *
 * 三个纯函数组成一条流水线：
 *   1. `parseLogLines()`    三种输入格式 → 逐行 entry（行号、时间、级别、消息、原始行）；
 *   2. `classifyLogLine()`  关键词分类 → category / severity；
 *   3. `buildLogEvidence()` 时间窗口合并 → evidence[]（脱敏、截断、排序、限量）。
 *
 * 安全红线（由 tests/phase-207-log-evidence.test.mjs 锁死）：
 *   - 零 I/O、零 import、零第三方依赖：不读任何真实日志文件，日志文本一律由调用方传入；
 *   - 不执行命令、不拼命令、不启动任何进程；
 *   - `evidence[]` 只保存脱敏并截断后的摘要，绝不携带 `entry.raw` 整行原文；
 *   - 脱敏先于入库：密码/令牌/Bearer 凭据/本机 home 目录前缀一律替换为 `[redacted]`；
 *   - 对无法识别的行保留 message、`at` 置 `null`、category 归 `unknown`，不猜故障类别。
 */

/** 允许的日志来源（调用方声明，用于标记 entry 的出处）。 */
export const LOG_SOURCES = Object.freeze(["kernel", "syslog", "docker", "trim"]);

/** 单次解析最多保留的行数（取最新的这么多行）。 */
export const MAX_LINES = 5000;

/** 单次证据构建最多保留的证据条数。 */
export const MAX_EVIDENCE = 40;

/** 单条证据明细的最大 Unicode 码点数。 */
export const MAX_DETAIL_LENGTH = 240;

/** 证据分类（`unknown` 是兜底，任何关键词都不命中时使用）。 */
export const LOG_CATEGORIES = Object.freeze([
  "io-error",
  "oom",
  "disk",
  "network",
  "permission",
  "service",
  "unknown"
]);

/** 证据严重级别，按严重程度升序。 */
export const LOG_SEVERITIES = Object.freeze(["info", "warning", "critical"]);

/**
 * 关键词表：**顺序即优先级**，一条 message 命中多条规则时取第一条。
 * 顺序按「根因优先」排列（例如 "Failed to start: No space left on device"
 * 应归为 disk 而不是 service）。
 *
 * 规则里的 `severity` 只是该关键词的最低级别：最终 severity 取
 * 「级别基线」与「关键词级别」中的较高者，永不降级。
 */
export const LOG_KEYWORDS = Object.freeze([
  Object.freeze({
    category: "oom",
    severity: "critical",
    patterns: Object.freeze([
      /out of memory/i,
      /\boom[-_ ]?kill(?:er|ed)?\b/i,
      /cannot allocate memory/i,
      /memory exhaustion/i
    ])
  }),
  Object.freeze({
    category: "io-error",
    severity: "critical",
    patterns: Object.freeze([
      /buffer i\/o error/i,
      /\bi\/o error\b/i,
      /input\/output error/i,
      /\bmedium error\b/i,
      /unrecovered read error/i,
      /failed command:\s*(?:read|write)/i
    ])
  }),
  Object.freeze({
    category: "disk",
    severity: "critical",
    patterns: Object.freeze([
      /no space left on device/i,
      /disk quota exceeded/i,
      /read-only file system/i,
      /filesystem is full/i,
      /not enough space/i
    ])
  }),
  Object.freeze({
    category: "network",
    severity: "warning",
    patterns: Object.freeze([
      /connection refused/i,
      /connection reset/i,
      /connection timed out/i,
      /\bno route to host\b/i,
      /network is unreachable/i,
      /temporary failure in name resolution/i
    ])
  }),
  Object.freeze({
    category: "permission",
    severity: "warning",
    patterns: Object.freeze([
      /permission denied/i,
      /operation not permitted/i,
      /authentication failure/i,
      /\bEACCES\b/,
      /\bEPERM\b/
    ])
  }),
  Object.freeze({
    category: "service",
    severity: "warning",
    patterns: Object.freeze([
      /failed to start/i,
      /failed to restart/i,
      /start request repeated too quickly/i,
      /main process exited/i,
      /unit .* (?:failed|entered failed state)/i
    ])
  })
]);

/** 解析不到级别时的默认值（与 system-events.mjs 的「不猜级别」一致）。 */
const DEFAULT_LEVEL = "notice";

/** 合并窗口默认值：同一 category+severity 相邻两条间隔不超过 60s 时合并。 */
const DEFAULT_GROUP_WINDOW_MS = 60_000;

/** 级别别名表：只做已知别名的归一，不做上下文推断。 */
const LEVEL_ALIASES = new Map([
  ["emerg", "emerg"],
  ["emergency", "emerg"],
  ["panic", "emerg"],
  ["alert", "alert"],
  ["crit", "crit"],
  ["critical", "crit"],
  ["fatal", "crit"],
  ["err", "err"],
  ["error", "err"],
  ["warning", "warning"],
  ["warn", "warning"],
  ["notice", "notice"],
  ["info", "info"],
  ["information", "info"],
  ["informational", "info"],
  ["debug", "debug"],
  ["trace", "debug"]
]);

/** severity 排序权重。 */
const SEVERITY_RANK = new Map([
  ["info", 0],
  ["warning", 1],
  ["critical", 2]
]);

/** 名称 → 序号的月份白名单（RFC 3164 的月份缩写）。 */
const MONTH_INDEX = new Map([
  ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4], ["may", 5], ["jun", 6],
  ["jul", 7], ["aug", 8], ["sep", 9], ["oct", 10], ["nov", 11], ["dec", 12]
]);

/**
 * 格式①：syslog 短格式（RFC 3164 风格）——
 * `Oct 23 01:12:33 host app[123]: message`。
 */
const RFC3164_LINE_PATTERN = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\S+)\s+([^\s\[\]:]+)(?:\[(\d+)\])?:\s?([\s\S]*)$/;

/**
 * 格式②：ISO 时间戳 + 级别 + 消息——
 * `2026-10-23T01:12:33.123+08:00 ERROR message`。
 */
const ISO_LINE_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+([\s\S]+)$/;

/** 格式②里级别记号的两种写法：`[ERROR]` 或 `ERROR:`。 */
const BRACKET_LEVEL_PATTERN = /^\[([A-Za-z][A-Za-z0-9]*)\]\s*:?\s*([\s\S]*)$/;
const WORD_LEVEL_PATTERN = /^([A-Za-z][A-Za-z0-9]*)\s*:?\s+([\s\S]*)$/;

/** ANSI CSI 转义序列（颜色、光标控制等）。 */
const ANSI_CSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** ANSI OSC 转义序列（`ESC ] ... BEL/ST`）。 */
const ANSI_OSC_PATTERN = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** ASCII 控制字符（C0 与 DEL）。 */
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]+/g;

/**
 * 密钥赋值：`password=xxx` / `token: xxx` / `api_key = "xxx"`。
 * 只替换「值」，保留键名与分隔符，便于阅读证据时知道被抹掉的是什么。
 */
const SECRET_ASSIGNMENT_PATTERN = /\b(pass(?:word)?|passwd|token|secret|api[-_]?key|credential)\b(\s*[:=]\s*)("[^"]{1,}"|'[^']{1,}'|[^\s,;)}\]]{1,})/gi;

/** 常见令牌形态：`sk-...`、`ghp_...`、`AKIA...`。 */
const SECRET_TOKEN_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16})\b/g;

/** `Authorization: Bearer <token>`。 */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * 本机 home 目录前缀：`/home/<user>`、`/Users/<user>`、`/root`、`C:\Users\<user>`。
 * 只抹掉「前缀」，路径的其余部分保留（证据仍可读，但用户名不落盘）。
 */
const HOME_PATH_PATTERN = /(?<![\w./-])(?:\/home\/[^/\s"':;,]+|\/Users\/[^/\s"':;,]+|\/root(?![A-Za-z0-9_-])|[A-Za-z]:\\Users\\[^\\\s"':;,]+)/g;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 把来源名归一：不在白名单里的名字一律回落到 "syslog"（不抛异常）。
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeSource(value) {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return LOG_SOURCES.includes(candidate) ? candidate : "syslog";
}

/**
 * 级别记号 → syslog 八级；无法识别返回 null。
 *
 * @param {unknown} token
 * @returns {string | null}
 */
function resolveLevel(token) {
  if (typeof token !== "string") return null;
  const key = token.trim().toLowerCase();
  if (key === "") return null;
  const level = LEVEL_ALIASES.get(key);
  return level === undefined ? null : level;
}

/**
 * 级别 → severity 基线。未知级别按 info 处理（不把「不知道」当严重）。
 *
 * @param {unknown} level
 * @returns {"info" | "warning" | "critical"}
 */
function severityForLevel(level) {
  const resolved = resolveLevel(level);
  switch (resolved) {
    case "emerg":
    case "alert":
    case "crit":
      return "critical";
    case "err":
    case "warning":
      return "warning";
    default:
      return "info";
  }
}

/**
 * 取两个 severity 中更严重的一个。
 *
 * @param {"info" | "warning" | "critical"} left
 * @param {"info" | "warning" | "critical"} right
 * @returns {"info" | "warning" | "critical"}
 */
function maxSeverity(left, right) {
  const leftRank = SEVERITY_RANK.get(left) ?? 0;
  const rightRank = SEVERITY_RANK.get(right) ?? 0;
  return leftRank >= rightRank ? left : right;
}

/**
 * 校验并归一一个时间戳字符串；空值或无法被 `Date.parse` 识别时返回 null。
 * 返回值是**原样文本**（RFC 短格式没有年份，不补年份、不编日期）。
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function parseTimestamp(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

/**
 * 尝试把一行当成 docker json-file 记录解析。
 * 只有带字符串 `log` 字段的 JSON 对象才算 docker 行；其余返回 null。
 *
 * @param {string} raw
 * @returns {object | null}
 */
function parseDockerRecord(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const record = JSON.parse(trimmed);
    if (isObject(record) && typeof record.log === "string") return record;
  } catch {
    // 不是合法 JSON：交给后面的格式解析，按普通日志行处理。
  }
  return null;
}

/**
 * 从 "级别 消息" 里拆出级别；级别不在别名表里就把整段当成消息（不丢内容）。
 *
 * @param {string} rest
 * @returns {{ level: string, message: string }}
 */
function splitLevelPrefix(rest) {
  const candidate = rest.trim();
  const bracket = BRACKET_LEVEL_PATTERN.exec(candidate);
  if (bracket !== null) {
    const level = resolveLevel(bracket[1]);
    if (level !== null) return { level, message: bracket[2] };
  }
  const word = WORD_LEVEL_PATTERN.exec(candidate);
  if (word !== null) {
    const level = resolveLevel(word[1]);
    if (level !== null) return { level, message: word[2] };
  }
  return { level: DEFAULT_LEVEL, message: candidate };
}

/**
 * 解析一行日志。识别顺序：docker json-file → ISO 时间戳 → RFC 3164 → 兜底。
 * 兜底行保留 message、`at` 为 null、级别为 notice，不丢行。
 *
 * @param {string} raw
 * @param {number} lineNumber
 * @param {string} source
 * @returns {{ lineNumber: number, at: string | null, level: string, message: string, raw: string, source: string }}
 */
function parseLine(raw, lineNumber, source) {
  const docker = parseDockerRecord(raw);
  if (docker !== null) {
    // docker json-file 本身没有级别字段；`stream` 不是级别，不据此抬升 severity。
    return {
      lineNumber,
      at: parseTimestamp(docker.time),
      level: DEFAULT_LEVEL,
      message: text(docker.log),
      raw,
      source
    };
  }

  const iso = ISO_LINE_PATTERN.exec(raw);
  if (iso !== null) {
    const at = parseTimestamp(iso[1]);
    if (at !== null) {
      const split = splitLevelPrefix(iso[2]);
      return { lineNumber, at, level: split.level, message: text(split.message), raw, source };
    }
    // 时间戳形态匹配但日期非法：不丢原文，整行按「无时间戳」兜底处理。
  }

  const rfc = RFC3164_LINE_PATTERN.exec(raw);
  if (rfc !== null && MONTH_INDEX.has(rfc[1].toLowerCase())) {
    // RFC 3164 没有年份也没有优先级：at 保留 "Mon DD HH:MM:SS" 原文，级别归 notice。
    const at = parseTimestamp(`${rfc[1]} ${rfc[2]} ${rfc[3]}`);
    return { lineNumber, at, level: DEFAULT_LEVEL, message: text(rfc[7]), raw, source };
  }

  return { lineNumber, at: null, level: DEFAULT_LEVEL, message: text(raw), raw, source };
}

/**
 * 解析多行日志文本。
 *
 * 行号是**文本里的物理行号**（1 起）；空行跳过但仍占行号。超过 `MAX_LINES`
 * 时只解析最新的 `MAX_LINES` 行，并返回 `truncated: true`。
 * 非字符串输入返回空结果，不抛异常。
 *
 * @param {unknown} text
 * @param {{ source?: string }} [options]
 * @returns {{ entries: Array<{ lineNumber: number, at: string | null, level: string, message: string, raw: string, source: string }>, truncated: boolean }}
 */
export function parseLogLines(text, options = {}) {
  const source = normalizeSource(isObject(options) ? options.source : undefined);
  if (typeof text !== "string" || text === "") return { entries: [], truncated: false };

  // 去掉结尾换行，避免「5000 行 + 末尾换行」被误判成 5001 行。
  const body = text.replace(/(?:\r\n|\n|\r)+$/, "");
  const lines = body === "" ? [] : body.split(/\r\n|\n|\r/);

  let truncated = false;
  let start = 0;
  if (lines.length > MAX_LINES) {
    start = lines.length - MAX_LINES;
    truncated = true;
  }

  const entries = [];
  for (let index = start; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.trim() === "") continue;
    entries.push(parseLine(raw, index + 1, source));
  }
  return { entries, truncated };
}

/**
 * 对一行日志做关键词分类。
 *
 * 分类只使用 message 正文（message 缺失时回退 raw，仅用于匹配，不写入证据）。
 * `severity` = max(级别基线, 关键词级别)：关键词只会升级、不会把 err 降成 info。
 *
 * @param {{ level?: string, message?: string, raw?: string } | string} entry
 * @returns {{ category: string, severity: "info" | "warning" | "critical" }}
 */
export function classifyLogLine(entry) {
  const record = isObject(entry) ? entry : null;
  const message = record !== null && typeof record.message === "string"
    ? record.message
    : record !== null && typeof record.raw === "string"
      ? record.raw
      : typeof entry === "string"
        ? entry
        : "";
  const level = record !== null && typeof record.level === "string" ? record.level : DEFAULT_LEVEL;
  const baseline = severityForLevel(level);

  for (const rule of LOG_KEYWORDS) {
    if (rule.patterns.some((pattern) => pattern.test(message))) {
      return { category: rule.category, severity: maxSeverity(baseline, rule.severity) };
    }
  }
  return { category: "unknown", severity: baseline };
}

/**
 * 对一行日志做脱敏，返回值可以直接放进证据。
 *
 * 处理顺序：ANSI 转义 → 密钥赋值 → 常见令牌 → Bearer → home 路径 → 控制字符。
 * 只做替换与压缩空白，不截断（截断由 `buildLogEvidence()` 统一执行）。
 * 非字符串输入返回空串，不抛异常。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function redactLogLine(text) {
  if (typeof text !== "string" || text === "") return "";
  let out = text.replace(ANSI_CSI_PATTERN, "").replace(ANSI_OSC_PATTERN, "");
  out = out.replace(SECRET_ASSIGNMENT_PATTERN, (_match, key, separator) => `${key}${separator}[redacted]`);
  out = out.replace(SECRET_TOKEN_PATTERN, "[redacted]");
  out = out.replace(BEARER_PATTERN, "Bearer [redacted]");
  out = out.replace(HOME_PATH_PATTERN, "[redacted]");
  out = out.replace(CONTROL_CHAR_PATTERN, " ");
  return out.replace(/\s+/g, " ").trim();
}

/**
 * 按码点截断明细，附带省略号；不会把代理对切成两半。
 *
 * @param {string} value
 * @returns {string}
 */
function capDetail(value) {
  if (typeof value !== "string" || value === "") return "";
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  if (flat.length <= MAX_DETAIL_LENGTH) return flat;
  const codePoints = Array.from(flat);
  if (codePoints.length <= MAX_DETAIL_LENGTH) return flat;
  return `${codePoints.slice(0, MAX_DETAIL_LENGTH - 1).join("")}…`;
}

/**
 * 读取并归一构建选项；非法值回落到默认值，不抛异常。
 *
 * @param {unknown} options
 * @returns {{ limit: number, groupWindowMs: number }}
 */
function readBuildOptions(options) {
  const record = isObject(options) ? options : {};
  const limit = Number.isSafeInteger(record.limit) && record.limit >= 0 ? record.limit : MAX_EVIDENCE;
  const groupWindowMs = Number.isFinite(record.groupWindowMs) && record.groupWindowMs >= 0
    ? record.groupWindowMs
    : DEFAULT_GROUP_WINDOW_MS;
  return { limit, groupWindowMs };
}

/**
 * 合并后的组排序：severity 降序 → count 降序 → 首次出现时间升序 →
 * category 字典序 → 输入顺序。排序完全确定，同一输入永远得到同一顺序。
 *
 * @param {object} left
 * @param {object} right
 * @returns {number}
 */
function compareGroups(left, right) {
  const severity = (SEVERITY_RANK.get(right.severity) ?? 0) - (SEVERITY_RANK.get(left.severity) ?? 0);
  if (severity !== 0) return severity;
  if (left.count !== right.count) return right.count - left.count;
  if (left.firstEpoch !== null && right.firstEpoch !== null && left.firstEpoch !== right.firstEpoch) {
    return left.firstEpoch - right.firstEpoch;
  }
  if (left.firstEpoch === null && right.firstEpoch !== null) return 1;
  if (left.firstEpoch !== null && right.firstEpoch === null) return -1;
  if (left.category !== right.category) return left.category < right.category ? -1 : 1;
  return left.order - right.order;
}

/**
 * 把解析后的 entry 聚合成诊断证据。
 *
 * 合并语义（会话窗口）：同一 category+severity 的相邻两条，若时间差
 * ≤ `groupWindowMs` 就并入同一组，否则另起一组。没有时间戳的 entry 无法
 * 参与窗口比较，同一 category+severity 的无时间 entry 会合并成单独一组
 * （`firstAt` / `lastAt` 为 null），不与有时间戳的组混在一起。
 *
 * 每组 `detail` 取组内时间最早（无时间则输入顺序最靠前）的一条 message，
 * 先 `redactLogLine()` 脱敏、再截断到 `MAX_DETAIL_LENGTH` 个码点。
 * `evidence[]` 按 compareGroups 排序后截取前 `limit` 条；`groups` 返回**全部**
 * 合并组的结构摘要（不含 detail），`groups.length > evidence.length` 即表示
 * 被 `limit` 截断。
 *
 * @param {Array<{ lineNumber?: number, at?: string | null, level?: string, message?: string, raw?: string, source?: string }>} entries
 * @param {{ limit?: number, groupWindowMs?: number }} [options]
 * @returns {{ evidence: Array<{ source: "log", category: string, severity: string, count: number, firstAt: string | null, lastAt: string | null, detail: string }>, groups: Array<{ category: string, severity: string, count: number, firstAt: string | null, lastAt: string | null }> }}
 */
export function buildLogEvidence(entries, options = {}) {
  const { limit, groupWindowMs } = readBuildOptions(options);
  const list = Array.isArray(entries) ? entries : [];

  const prepared = [];
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index];
    if (!isObject(entry)) continue;
    const at = parseTimestamp(entry.at);
    const classification = classifyLogLine(entry);
    const message = typeof entry.message === "string" ? entry.message : "";
    prepared.push({
      index,
      at,
      epoch: at === null ? null : Date.parse(at),
      category: classification.category,
      severity: classification.severity,
      detail: capDetail(redactLogLine(message))
    });
  }

  // 先按时间排序（无时间的排在最后，内部保持输入顺序），窗口合并才有意义。
  prepared.sort((left, right) => {
    if (left.epoch !== null && right.epoch !== null) {
      return left.epoch - right.epoch || left.index - right.index;
    }
    if (left.epoch === null && right.epoch === null) return left.index - right.index;
    return left.epoch === null ? 1 : -1;
  });

  const groups = [];
  const timedOpen = new Map();
  const untimedOpen = new Map();

  for (const item of prepared) {
    const key = `${item.category}\u0000${item.severity}`;
    if (item.epoch === null) {
      const existing = untimedOpen.get(key);
      if (existing !== undefined) {
        existing.count += 1;
        continue;
      }
      const group = {
        category: item.category,
        severity: item.severity,
        count: 1,
        firstAt: null,
        lastAt: null,
        firstEpoch: null,
        lastEpoch: null,
        detail: item.detail,
        order: groups.length
      };
      untimedOpen.set(key, group);
      groups.push(group);
      continue;
    }

    const open = timedOpen.get(key);
    if (open !== undefined && item.epoch - open.lastEpoch <= groupWindowMs) {
      open.count += 1;
      open.lastAt = item.at;
      open.lastEpoch = item.epoch;
      continue;
    }

    const group = {
      category: item.category,
      severity: item.severity,
      count: 1,
      firstAt: item.at,
      lastAt: item.at,
      firstEpoch: item.epoch,
      lastEpoch: item.epoch,
      detail: item.detail,
      order: groups.length
    };
    timedOpen.set(key, group);
    groups.push(group);
  }

  const ordered = [...groups].sort(compareGroups);

  return {
    evidence: ordered.slice(0, limit).map((group) => ({
      source: "log",
      category: group.category,
      severity: group.severity,
      count: group.count,
      firstAt: group.firstAt,
      lastAt: group.lastAt,
      detail: group.detail
    })),
    groups: ordered.map((group) => ({
      category: group.category,
      severity: group.severity,
      count: group.count,
      firstAt: group.firstAt,
      lastAt: group.lastAt
    }))
  };
}

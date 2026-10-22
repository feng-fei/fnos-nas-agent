/**
 * Phase 194 — 系统事件解析与聚合（纯函数）
 *
 * 目标：把三种最常见的日志行解析成统一的事件对象，再把事件聚合成一个可以
 * 被解释、被核对、也不会把「不知道」说成「没事」的结论：
 *
 *   (a) kmsg：`<N>message` 的优先级前缀，或 `kern.err: message` 的「设施.级别」写法；
 *   (b) journalctl short：`Oct 24 01:02:03 host unit[pid]: message`；
 *   (c) 纯 `LEVEL: message`。
 *
 * 红线：
 *   - **零 I/O、零依赖、零 import**：不读文件、不起进程、不发网络请求；
 *   - **不猜**：journalctl short 本身没有优先级字段，就归 `notice` 并记账，绝不
 *     从消息正文里猜级别；kmsg 的 `[12345.678]` 是 monotonic（开机秒数）而不是墙钟
 *     时间，`timestamp` 留 `null`，绝不编一个日期出来；journalctl 行里没有年份，
 *     就原样保留 `Mon DD HH:MM:SS`，不补年份；
 *   - **有界**：单条 message 截断到 240 个 Unicode 码点；
 *   - **对账**：`dropped` 与 notes 里 `dropped:` 的条数必须一致，无法识别的行
 *     不会静默消失。
 */

/** syslog 的八级 severity，从最严重到最不严重。 */
export const EVENT_LEVELS = Object.freeze([
  "emerg",
  "alert",
  "crit",
  "err",
  "warning",
  "notice",
  "info",
  "debug"
]);

/** 单条 message 的截断上限（按 Unicode 码点计，不会切断代理对）。 */
export const MAX_MESSAGE_LENGTH = 240;

/** `summarizeEvents()` 的 repeated 分组默认上限。 */
export const DEFAULT_REPEAT_LIMIT = 20;

/** 无法识别（或缺失）级别时统一落到这一级。 */
const UNKNOWN_LEVEL = "notice";

const LEVEL_SET = new Set(EVENT_LEVELS);

/**
 * 常见级别别名。只收录业界有明确约定的写法（syslog 官方名、Python logging
 * 的 `ERROR`/`WARN`/`CRITICAL`、内核 panic），不做「按上下文猜」。
 * 关键取舍：`error` 必须映射到 `err` 而不是当成未知级别降到 `notice` —— 把
 * 明确的错误降级成通知，会让后面的 verdict 把故障说成 `ok`。
 */
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

/** journalctl short 的月份缩写；大小写不敏感，输出统一成规范大小写。 */
const MONTH_NAMES = Object.freeze([
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
]);

const MONTH_BY_LOWER = new Map(MONTH_NAMES.map(name => [name.toLowerCase(), name]));

/** `<N>message`（N 为 1-3 位十进制，按 syslog PRI 解释）。 */
const KMSG_PREFIX_PATTERN = /^<\s*(\d{1,3})\s*>\s?([\s\S]*)$/;

/** kmsg / dmesg 正文前的 monotonic 时间戳：`[  123.456789]`。 */
const KMSG_MONOTONIC_PATTERN = /^\[\s*\d+(?:\.\d+)?\s*\]\s*/;

/** `kern.err: message` 这种「设施.级别: 正文」写法。 */
const FACILITY_LEVEL_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*)\.([A-Za-z][A-Za-z0-9_-]*)\s*:\s*([\s\S]*)$/;

/** journalctl short：`Oct 24 01:02:03 host unit[pid]: message`。 */
const JOURNAL_SHORT_PATTERN = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\S+)\s+([^\s\[\]:]+)(?:\[(\d+)\])?:\s?([\s\S]*)$/;

/** 纯 `LEVEL: message`。 */
const PLAIN_LEVEL_PATTERN = /^([A-Za-z][A-Za-z0-9_.-]*)\s*:\s*([\s\S]*)$/;

/** ASCII 控制字符（C0 与 DEL）。 */
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/g;

/** UUID（先小写化再匹配）。 */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** 十六进制字面量。 */
const HEX_PATTERN = /\b0x[0-9a-f]+\b/g;

/**
 * 绝对路径片段（以 `/` 开头、至少两段或单段均可）。
 * 前置断言要求 `/` 前面不是单词字符或点，避免把 `and/or` 里的 `/or` 当路径。
 */
const PATH_PATTERN = /(?<![\w.])\/(?:[a-z0-9._@-]+\/?)+/g;

/** 十进制数字（含小数）。 */
const NUMBER_PATTERN = /\b\d+(?:\.\d+)?\b/g;

function normalizeControlChars(text) {
  return text.replace(CONTROL_CHAR_PATTERN, " ");
}

/**
 * 把级别记号解析成 `EVENT_LEVELS` 里的一项；无法识别返回 `null`。
 * 这里只做大小写归一与别名查表，不做任何启发式推断。
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
 * `<N>` 里的 N 是 syslog PRI（facility × 8 + severity）时，取低 3 位还原级别。
 * 0-7 直接就是 severity；8-191 是合法的 PRI；其余视为未知。
 *
 * @param {number} priority
 * @returns {string | null}
 */
function levelFromPriority(priority) {
  if (!Number.isInteger(priority) || priority < 0) return null;
  if (priority <= 7) return EVENT_LEVELS[priority];
  if (priority <= 191) return EVENT_LEVELS[priority & 7];
  return null;
}

/**
 * 按码点截断到 `MAX_MESSAGE_LENGTH`，不会把代理对切成两半。
 *
 * @param {string} text
 * @returns {{ text: string, truncated: boolean }}
 */
function capMessage(text) {
  if (text.length <= MAX_MESSAGE_LENGTH) return { text, truncated: false };
  const codePoints = Array.from(text);
  if (codePoints.length <= MAX_MESSAGE_LENGTH) return { text, truncated: false };
  return { text: codePoints.slice(0, MAX_MESSAGE_LENGTH).join(""), truncated: true };
}

/**
 * 解析多行日志文本。
 *
 * 识别顺序（先具体后宽泛，保证 `kern.err:` 不会被当成纯 `LEVEL:`）：
 * kmsg `<N>` → `facility.level:` → journalctl short → 纯 `LEVEL:`。
 *
 * 返回的 `events` 按输入行序排列，每项严格只有
 * `{ level, source, timestamp, message }` 四个字段：
 *   - kmsg：`source: "kernel"`、`timestamp: null`（monotonic 不是墙钟）；
 *   - `facility.level:`：`source` 为小写设施名（如 `kern`）、`timestamp: null`；
 *   - journalctl short：`source` 为 unit 名（去掉 `[pid]`）、`timestamp` 为
 *     `Mon DD HH:MM:SS`（不补年份）、级别未知 → `notice`；
 *   - 纯 `LEVEL:`：`source: "log"`（无来源信息，不用主机名/unit 名冒充）、
 *     `timestamp: null`。
 *
 * 无法识别任何格式的非空行计入 `dropped`，并在 notes 里给出同数量的
 * `dropped: N unrecognized line(s)`；空行/纯空白行直接跳过，不计入 `dropped`。
 * 未知级别（含 journalctl short 缺优先级这种「本来就没有级别」的情况）归
 * `notice`，同样在 notes 里记账。
 *
 * @param {unknown} text
 * @returns {{ events: Array<{ level: string, source: string, timestamp: string | null,
 *   message: string }>, dropped: number, notes: string[] }}
 */
export function parseLogLines(text) {
  const events = [];
  const notes = [];

  if (typeof text !== "string") {
    notes.push("invalid-input: expected log text");
    return { events, dropped: 0, notes };
  }

  let dropped = 0;
  let unknownLevelCount = 0;
  let journalWithoutPriority = 0;
  let priDecoded = 0;
  let truncatedCount = 0;

  const pushEvent = (level, source, timestamp, rawMessage) => {
    const message = normalizeControlChars(rawMessage).trim();
    const capped = capMessage(message);
    if (capped.truncated) truncatedCount += 1;
    events.push({ level, source, timestamp, message: capped.text });
  };

  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line.trim() === "") continue;

    const kmsg = KMSG_PREFIX_PATTERN.exec(line);
    if (kmsg !== null) {
      const priority = Number(kmsg[1]);
      let level = levelFromPriority(priority);
      if (level === null) {
        unknownLevelCount += 1;
        level = UNKNOWN_LEVEL;
      } else if (priority > 7) {
        priDecoded += 1;
      }
      pushEvent(level, "kernel", null, kmsg[2].replace(KMSG_MONOTONIC_PATTERN, ""));
      continue;
    }

    const facility = FACILITY_LEVEL_PATTERN.exec(line);
    if (facility !== null) {
      const resolved = resolveLevel(facility[2]);
      let level = resolved;
      if (level === null) {
        unknownLevelCount += 1;
        level = UNKNOWN_LEVEL;
      }
      pushEvent(level, facility[1].toLowerCase(), null, facility[3]);
      continue;
    }

    const journal = JOURNAL_SHORT_PATTERN.exec(line);
    if (journal !== null) {
      const month = MONTH_BY_LOWER.get(journal[1].toLowerCase());
      if (month !== undefined) {
        // journalctl short 没有优先级字段：不猜级别，归 notice 并记账。
        journalWithoutPriority += 1;
        pushEvent(UNKNOWN_LEVEL, journal[5], `${month} ${journal[2]} ${journal[3]}`, journal[7]);
        continue;
      }
    }

    const plain = PLAIN_LEVEL_PATTERN.exec(line);
    if (plain !== null) {
      const resolved = resolveLevel(plain[1]);
      let level = resolved;
      if (level === null) {
        unknownLevelCount += 1;
        level = UNKNOWN_LEVEL;
      }
      pushEvent(level, "log", null, plain[2]);
      continue;
    }

    dropped += 1;
  }

  if (dropped > 0) notes.push(`dropped: ${dropped} unrecognized line(s)`);
  if (unknownLevelCount > 0) notes.push(`unknown-level: ${unknownLevelCount} line(s) mapped to notice`);
  if (journalWithoutPriority > 0) notes.push(`journalctl-priority-missing: ${journalWithoutPriority} line(s) mapped to notice`);
  if (priDecoded > 0) notes.push(`pri-decoded: ${priDecoded} line(s)`);
  if (truncatedCount > 0) notes.push(`truncated: ${truncatedCount} message(s)`);

  return { events, dropped, notes };
}

/**
 * 把一条消息归一成聚合用的分组键：小写化、控制字符转空格、压缩空白，并把
 * 会随实例变化的片段替换成占位符：
 *
 *   - 绝对路径 `/var/log/x.log` → `<path>`；
 *   - UUID → `<uuid>`；
 *   - `0xdeadbeef` → `<hex>`；
 *   - 数字（含小数）→ `<num>`。
 *
 * 非字符串输入返回空串（不抛错，调用方自行判断）。
 *
 * @param {unknown} message
 * @returns {string}
 */
export function normalizeEventMessage(message) {
  if (typeof message !== "string") return "";
  return normalizeControlChars(message)
    .toLowerCase()
    .replace(PATH_PATTERN, "<path>")
    .replace(UUID_PATTERN, "<uuid>")
    .replace(HEX_PATTERN, "<hex>")
    .replace(NUMBER_PATTERN, "<num>")
    .replace(/\s+/g, " ")
    .trim();
}

function readEventList(input) {
  if (Array.isArray(input)) return input;
  if (input !== null && typeof input === "object" && Array.isArray(input.events)) {
    return input.events;
  }
  throw new TypeError("summarizeEvents() expects an event array or { events: [...] }");
}

function readRepeatLimit(options) {
  if (options === undefined) return DEFAULT_REPEAT_LIMIT;
  if (options === null || typeof options !== "object") {
    throw new TypeError("summarizeEvents() options must be an object");
  }
  const { limit } = options;
  if (limit === undefined) return DEFAULT_REPEAT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError("summarizeEvents() limit must be a positive integer");
  }
  return limit;
}

function emptyCounts() {
  return {
    emerg: 0,
    alert: 0,
    crit: 0,
    err: 0,
    warning: 0,
    notice: 0,
    info: 0,
    debug: 0
  };
}

/**
 * 汇总事件列表。
 *
 * `input` 可以是事件数组，也可以是 `{ events: [...] }`（例如 `parseLogLines()`
 * 的返回值）；其他形状抛 `TypeError`。
 *
 * 结论规则（**空输入不是 ok**）：
 *   - 没有任何可用事件（空列表、全是没有合法 level 的条目）→ `unknown`；
 *   - 有 `crit`/`alert`/`emerg` → `critical`；
 *   - 有 `err`（且没有更高级别）→ `warning`；
 *   - 只有 `warning`/`notice`/`info`/`debug` → `ok`。
 *
 * `repeated` 按归一后的消息分组，按 `count` 降序、`count` 相同按首次出现顺序排列，
 * 最多返回 `limit` 项。每项保留 `firstSample`（首条原始消息，仅控制字符转空格、
 * 不做小写/占位符替换，按码点截断到 240）与首条事件的 `level`。
 *
 * `limit` 非法（0、负数、非整数、`NaN`、`Infinity`、非数字）抛 `TypeError`；
 * 缺省为 20。
 *
 * @param {unknown} input
 * @param {{ limit?: number }} [options]
 * @returns {{ verdict: "ok" | "warning" | "critical" | "unknown",
 *   counts: Record<string, number>,
 *   repeated: Array<{ normalized: string, count: number, firstSample: string, level: string }>,
 *   notes: string[] }}
 */
export function summarizeEvents(input, options = {}) {
  const events = readEventList(input);
  const limit = readRepeatLimit(options);

  const counts = emptyCounts();
  const groups = new Map();
  const notes = [];
  let validEvents = 0;
  let invalidEvents = 0;
  let emptyMessages = 0;
  let truncatedSamples = 0;

  events.forEach((event, index) => {
    const record = event !== null && typeof event === "object" ? event : null;
    const rawLevel = record !== null && typeof record.level === "string"
      ? record.level.trim().toLowerCase()
      : "";
    if (!LEVEL_SET.has(rawLevel)) {
      invalidEvents += 1;
      return;
    }
    counts[rawLevel] += 1;
    validEvents += 1;

    const rawMessage = record !== null && typeof record.message === "string" ? record.message : "";
    const message = normalizeControlChars(rawMessage).trim();
    if (message === "") {
      emptyMessages += 1;
      return;
    }
    const normalized = normalizeEventMessage(message);
    if (normalized === "") {
      emptyMessages += 1;
      return;
    }

    const existing = groups.get(normalized);
    if (existing !== undefined) {
      existing.count += 1;
      return;
    }

    const sample = capMessage(message);
    if (sample.truncated) truncatedSamples += 1;
    groups.set(normalized, {
      normalized,
      count: 1,
      firstSample: sample.text,
      level: rawLevel,
      firstIndex: index
    });
  });

  const ordered = [...groups.values()]
    .sort((left, right) => right.count - left.count || left.firstIndex - right.firstIndex)
    .map(({ normalized, count, firstSample, level }) => ({ normalized, count, firstSample, level }));
  const repeated = ordered.slice(0, limit);

  if (events.length === 0) {
    notes.push("no-events");
  } else if (validEvents === 0) {
    notes.push("no-valid-events");
  }
  if (invalidEvents > 0) notes.push(`invalid-event: ${invalidEvents} event(s) ignored`);
  if (emptyMessages > 0) notes.push(`empty-message: ${emptyMessages} event(s) not grouped`);
  if (truncatedSamples > 0) notes.push(`sample-truncated: ${truncatedSamples} first sample(s)`);
  if (ordered.length > repeated.length) {
    notes.push(`repeated-truncated: ${ordered.length - repeated.length} group(s) omitted`);
  }

  let verdict = "unknown";
  if (validEvents > 0) {
    if (counts.emerg + counts.alert + counts.crit > 0) {
      verdict = "critical";
    } else if (counts.err > 0) {
      verdict = "warning";
    } else {
      verdict = "ok";
    }
  }

  return { verdict, counts, repeated, notes };
}

/**
 * Phase 198 — 证书检查（纯函数层）
 *
 * 本层只回答三个问题：这张证书「还能用多久」、「给的这个主机名与它对不对得上」、
 * 以及「把两者合起来该给什么结论」。它不解析 DER/PEM，不读证书文件，不连 TLS 端口，
 * 不调用外部命令行工具，也不决定证书从哪来；真正的采集（远端 agent 上报、
 * NAS 反代配置读取）留给调用方。
 *
 * 红线：
 *   - 零 I/O、零依赖、零 import；
 *   - 采集层给的 record 一律当作不可信输入：对象形状、日期、SAN 形状全部先校验；
 *   - 解析不了就返回 null / verdict "unknown"，绝不把「没读到」说成 "ok"；
 *   - hostname 信息不足时 matchesHostname 返回 null（不猜），summarize 只记 note 不改结论；
 *   - 已证的事实不做二次猜测：SAN 里有 dNSName 就不回落 CN，IP 主机名只认 iPAddress；
 *   - 只有「调用方用错 API」（非对象 options、非法 warnDays）才抛 TypeError；
 *   - 数据本身有问题一律用「返回值 + 稳定 note」表达，不抛异常。
 */

/** 一天的毫秒数。 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 主名（hostname）最大长度（RFC 1035 的点分文本上限）。 */
const MAX_HOSTNAME_LENGTH = 253;

/** 证书结论取值。 */
export const CERT_VERDICTS = Object.freeze({
  OK: "ok",
  EXPIRING: "expiring",
  EXPIRED: "expired",
  INVALID: "invalid",
  UNKNOWN: "unknown"
});

/** 默认提前多少天开始告警。 */
export const DEFAULT_WARN_DAYS = 30;

/** SAN 条目上限；超出部分被截断，且因此不再允许「没匹配上 ⇒ false」的结论。 */
export const MAX_SAN_ENTRIES = 50;

/**
 * 结论备注（稳定标识，便于日志、UI 与断言）。
 *
 * 每条备注都是**不含证书内容**的短标识：不回显 subject、issuer、SAN、主机名，
 * 因此可以安全地落日志、进上报、进工单。
 */
export const CERT_NOTES = Object.freeze({
  RECORD_MISSING: "record-missing",
  RECORD_UNREADABLE: "record-unreadable",
  RECORD_INVALID: "record-invalid",
  NOT_AFTER_MISSING: "not-after-missing",
  NOT_AFTER_INVALID: "not-after-invalid",
  NOT_BEFORE_MISSING: "not-before-missing",
  NOT_BEFORE_INVALID: "not-before-invalid",
  RANGE_INVALID: "range-invalid",
  NOW_MISSING: "now-missing",
  NOW_INVALID: "now-invalid",
  EXPIRED: "expired",
  EXPIRING: "expiring",
  HOSTNAME_NOT_CHECKED: "hostname-not-checked",
  HOSTNAME_INVALID: "hostname-invalid",
  HOSTNAME_UNKNOWN: "hostname-unknown",
  HOSTNAME_MISMATCH: "hostname-mismatch"
});

/**
 * 严格 ISO 8601 时间戳正则。
 *
 * 只接受两种形状：
 *   1. 纯日期 `YYYY-MM-DD`（按 UTC 零点解释，与 ECMAScript 的 date-only 规则一致）；
 *   2. `YYYY-MM-DDTHH:MM[:SS[.fffffffff]]`，且**必须带时区**（`Z` 或 `±HH:MM`）。
 *
 * 捕获组：1=年、2=月、3=日、4=时、5=分、6=秒、7=小数秒、8=时区。
 * 故意不接受「不带时区的日期时间」（`2026-01-01T00:00:00`）：ECMAScript 把它解释为
 * 本机时区，同一条记录换台机器就会算出不同结论；也不接受 `MMM DD ...` 这类本地化写法。
 */
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2}))?$/;

/**
 * IPv4 字面量：四段十进制，每段 0-255，**不允许前导零**
 * （`010.0.0.1` 不是规范写法，本层拒绝猜它是不是同一个地址）。
 */
const IPV4_PATTERN = /^(?:(?:0|[1-9]\d{0,2})\.){3}(?:0|[1-9]\d{0,2})$/;

/** 单个 DNS 标签：1-63 字符，字母数字与连字符，不以连字符开头/结尾。 */
const HOSTNAME_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** 从 DN 文本里取 CN 组件（`CN=x`、`, CN = x`、`/CN=x` 均可）。 */
const COMMON_NAME_PATTERN = /(?:^|[,/])\s*CN\s*=\s*"?([^",/]+)"?/i;

/**
 * SAN 类型的已知别名 → 规范类型。
 *
 * 用 null 原型对象，避免 `"constructor"` 之类来自不可信输入的类型名命中原型链；
 * 未收录的类型保持原样（例如 `email`、`URI`、`DirName`），它们被保留在 san 里供审计，
 * 但**不参与**主机名匹配。
 */
const SAN_TYPE_ALIASES = Object.freeze(Object.assign(Object.create(null), {
  dns: "DNS",
  dnsname: "DNS",
  "dns name": "DNS",
  ip: "IP Address",
  ipaddress: "IP Address",
  "ip address": "IP Address"
}));

/** SAN 条目无法识别时用的内部标记（区别于「空白条目，跳过」的 null）。 */
const SAN_UNREADABLE = Symbol("san-unreadable");

/**
 * 是否为普通对象（排除 null 与数组）。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 判断一个字段是否算「没给」：undefined / null / 纯空白字符串。
 *
 * 与 update-check 的约定一致：missing 与 invalid 必须分开记，
 * 前者是「没拿到」，后者是「拿到了但读不懂」。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isMissingValue(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * 解析 ISO 时区后缀为「相对 UTC 的分钟偏移」。
 *
 * @param {string | undefined} zone `Z`、`+08:00`、`-05:30` 之一；undefined 表示没有时间部分
 * @returns {number | null} 偏移分钟；非法返回 null
 */
function parseZoneOffset(zone) {
  if (zone === undefined || zone === "Z") return 0;
  const sign = zone.startsWith("-") ? -1 : 1;
  const hours = Number(zone.slice(1, 3));
  const minutes = Number(zone.slice(4, 6));
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours > 23 || minutes > 59) return null;
  return sign * (hours * 60 + minutes);
}

/**
 * 按严格 ISO 8601 解析时间戳，返回 UTC 毫秒。
 *
 * 全程自己算，不依赖 `new Date(string)` 的实现细节（不同引擎对本地化写法的解释不同）：
 *   - 各段范围先校验；
 *   - 日期用 `setUTCFullYear/setUTCHours` 组装后**回读校验**，`2026-02-30` 这类
 *     「会被 Date 顺延」的非法日期直接判非法，而不是接受归一化后的猜测值；
 *   - 小数秒超过 3 位按毫秒截断（ISO 语义：`.123456` → 123 ms）；
 *   - 有时区偏移时减去偏移得到 UTC。
 *
 * @param {string} text 已 trim 的字符串
 * @returns {number | null} UTC 毫秒；非法返回 null
 */
function parseIsoTimestamp(text) {
  const match = ISO_TIMESTAMP_PATTERN.exec(text);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const millisecond = match[7] === undefined ? 0 : Number(match[7].slice(0, 3).padEnd(3, "0"));

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  // 回读校验：任何越界（2-30、4-31、24:00、闰秒 60）都会让 Date 顺延，这里一律拒绝。
  if (date.getUTCFullYear() !== year) return null;
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  if (date.getUTCHours() !== hour || date.getUTCMinutes() !== minute) return null;
  if (date.getUTCSeconds() !== second) return null;

  const offsetMinutes = parseZoneOffset(match[8]);
  if (offsetMinutes === null) return null;

  const time = date.getTime() - offsetMinutes * 60 * 1000;
  return Number.isFinite(time) ? time : null;
}

/**
 * 把「ISO 字符串或 epoch 毫秒」归一成 UTC 毫秒。
 *
 * - number：按 epoch 毫秒处理（非有限数、超出 Date 范围 → null）；
 * - string：必须是严格 ISO 8601（见 ISO_TIMESTAMP_PATTERN）；
 * - 其它类型（含 Date 实例、布尔、对象）→ null，不猜。
 *
 * 注意纯数字字符串（如 `"1735689600000"`）**不被当作 epoch 毫秒**：
 * `"20260101"` 既可以读成 ISO 基本格式日期、也可以读成毫秒，属于歧义，宁可判非法。
 *
 * @param {unknown} value
 * @returns {number | null} UTC 毫秒；非法返回 null
 */
function parseTimestampValue(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value !== "string") return null;
  return parseIsoTimestamp(value.trim());
}

/**
 * 读取一个时间字段，区分「没给」与「给了但读不懂」。
 *
 * @param {unknown} value
 * @returns {{ status: "missing" | "invalid" | "valid", iso: string | null }}
 */
function readTimestampField(value) {
  if (isMissingValue(value)) return { status: "missing", iso: null };
  const time = parseTimestampValue(value);
  if (time === null) return { status: "invalid", iso: null };
  return { status: "valid", iso: new Date(time).toISOString() };
}

/**
 * 归一 DN 文本（subject / issuer）。
 *
 * 只接受字符串：对象形态（`{ CN: "x" }`）里到底哪个键是 CN 属于歧义，
 * 本层不猜，统一归一为 null，由采集层负责把 DN 序列化成字符串。
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function readDnText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

/**
 * 判断字符串是否为规范 IPv4 字面量（四段，每段 0-255，无前导零）。
 *
 * @param {string} text
 * @returns {boolean}
 */
function isIpv4Literal(text) {
  if (typeof text !== "string" || !IPV4_PATTERN.test(text)) return false;
  return text.split(".").every((part) => Number(part) <= 255);
}

/**
 * 规范 SAN 类型名：已知别名归一，未知类型保持原样；空类型按取值语法推断。
 *
 * @param {string} rawType
 * @param {string} value
 * @returns {string}
 */
function canonicalSanType(rawType, value) {
  const text = rawType.trim();
  if (text === "") return isIpv4Literal(value) ? "IP Address" : "DNS";
  const alias = SAN_TYPE_ALIASES[text.toLowerCase()];
  return alias === undefined ? text : alias;
}

/**
 * 归一单条 SAN 条目。
 *
 * 接受两种形状：
 *   1. 字符串。含 `:` 的按 `TYPE:value` 读（这是 `X509Certificate.subjectAltName`
 *      与各类采集脚本的既有写法）；不含 `:` 的按语法判定：IPv4 字面量 → `IP Address`，其余 → `DNS`。
 *   2. `{ type, value }` 且两者都是字符串的对象。
 *
 * 空白条目（`""`、值全为空白）没有信息量，跳过；**无法识别的形状**返回
 * SAN_UNREADABLE，让整条记录作废（见 normalizeSanEntries）。
 *
 * @param {unknown} entry
 * @returns {string | null | typeof SAN_UNREADABLE}
 */
function normalizeSanEntry(entry) {
  let rawType = "";
  let rawValue = "";

  if (typeof entry === "string") {
    const text = entry.trim();
    if (text === "") return null;
    const separator = text.indexOf(":");
    if (separator >= 0) {
      rawType = text.slice(0, separator);
      rawValue = text.slice(separator + 1);
    } else {
      rawValue = text;
    }
  } else if (
    isPlainObject(entry) &&
    typeof entry.type === "string" &&
    typeof entry.value === "string"
  ) {
    rawType = entry.type;
    rawValue = entry.value;
  } else {
    return SAN_UNREADABLE;
  }

  const value = rawValue.trim();
  if (value === "") return null;
  return `${canonicalSanType(rawType, value)}:${value}`;
}

/**
 * 归一 SAN 数组。
 *
 * - 没给（undefined / null）→ `[]`（「证书没有 SAN 扩展」）；
 * - 非数组（含把 `subjectAltName` 原文整串塞进来的字符串）→ null（整条记录不可用）。
 *   逗号切分不可靠（DirName 的值里就带逗号），所以要求采集层切好数组；
 * - 出现无法识别的条目 → null（整条记录不可用）。理由：SAN 是「名字在不在证书里」的
 *   唯一证据，读不全就无法证明「不在」，宁可 unknown；
 * - 超过 MAX_SAN_ENTRIES 截断，后面的条目不再读取（有界性）。
 *
 * @param {unknown} value
 * @returns {string[] | null}
 */
function normalizeSanEntries(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;

  const entries = [];
  for (const entry of value) {
    if (entries.length >= MAX_SAN_ENTRIES) break;
    const normalized = normalizeSanEntry(entry);
    if (normalized === SAN_UNREADABLE) return null;
    if (normalized !== null) entries.push(normalized);
  }
  return entries;
}

/**
 * 归一采集层给的证书记录。
 *
 * 输入是采集层给的**普通对象**（字段可能是 ISO 字符串或 epoch 毫秒）。
 * 本函数只做归一与校验，不解析 DER/PEM、不推导证书内容：
 *
 * - `subject` / `issuer`：字符串 trim 后保留；非字符串或空白 → null；
 * - `notBefore` / `notAfter`：归一成规范 ISO 8601 UTC 字符串（`.toISOString()` 形态）；
 *   没给 → null；给了但读不懂 → null 且 `parsed` 为 false；
 * - `san`：归一成 `"TYPE:value"` 字符串数组（类型已规范化），空数组表示没有 SAN 扩展；
 * - `parsed`：**没有**时间字段读不懂时为 true；任一已给出的时间字段读不懂时为 false。
 *   缺失字段不算解析失败（缺字段 → 结论 unknown，不是 invalid）。
 *
 * 返回 null 的两种情况：入参不是普通对象；SAN 形状无法识别（非数组 / 含不可识别条目）。
 *
 * @param {unknown} input
 * @returns {{ subject: string | null, issuer: string | null,
 *   notBefore: string | null, notAfter: string | null,
 *   san: string[], parsed: boolean } | null}
 */
export function parseCertificateRecord(input) {
  if (!isPlainObject(input)) return null;

  const san = normalizeSanEntries(input.san);
  if (san === null) return null;

  const notBefore = readTimestampField(input.notBefore);
  const notAfter = readTimestampField(input.notAfter);

  return {
    subject: readDnText(input.subject),
    issuer: readDnText(input.issuer),
    notBefore: notBefore.iso,
    notAfter: notAfter.iso,
    san,
    parsed: notBefore.status !== "invalid" && notAfter.status !== "invalid"
  };
}

/**
 * 距离 `notAfter` 还有多少天。
 *
 * - `notAfter` 与 `now` 都接受 ISO 字符串或 epoch 毫秒；
 * - `now` 省略时取 `Date.now()`（本模块唯一的非确定性来源，测试总是显式传入）；
 * - 结果按天**向下取整**：剩余不足一天算 0，已过期算负数（差 1 小时 → -1），
 *   宁可提前一天告警，也不晚报；
 * - 任一侧非法 → null（不猜）。
 *
 * @param {unknown} notAfter
 * @param {unknown} [now]
 * @returns {number | null}
 */
export function daysUntilExpiry(notAfter, now) {
  const notAfterTime = parseTimestampValue(notAfter);
  if (notAfterTime === null) return null;

  const nowValue = now === undefined ? Date.now() : now;
  const nowTime = parseTimestampValue(nowValue);
  if (nowTime === null) return null;

  return Math.floor((notAfterTime - nowTime) / MS_PER_DAY);
}

/**
 * 归一待匹配的主机名。
 *
 * 规则：
 *   - 必须是字符串；trim 后去掉**一个**末尾点（DNS 绝对形式 `example.com.`）；
 *   - 长度 ≤ 253、不含 `*`、不含 `:`；
 *   - 规范 IPv4 字面量 → `{ kind: "ip" }`；其余按标签校验 → `{ kind: "dns", value: 小写 }`；
 *   - 无法归类 → null（非法主机名）。
 *
 * `*` 一律拒绝：主机名是待验证的对象，带通配符只能说明调用方搞错了参数。
 * 含 `:` 的（IPv6）也拒绝：未做地址规范化就不下结论（见文档「遗留」）。
 *
 * @param {unknown} value
 * @returns {{ kind: "dns" | "ip", value: string } | null}
 */
function normalizeHostname(value) {
  if (typeof value !== "string") return null;
  let text = value.trim();
  if (text === "") return null;
  if (text.endsWith(".")) text = text.slice(0, -1);
  if (text === "" || text.length > MAX_HOSTNAME_LENGTH) return null;
  if (text.includes("*")) return null;
  if (text.includes(":")) return null;

  if (isIpv4Literal(text)) return { kind: "ip", value: text };

  const labels = text.split(".");
  if (!labels.every((label) => HOSTNAME_LABEL_PATTERN.test(label))) return null;
  return { kind: "dns", value: text.toLowerCase() };
}

/**
 * DNS 名（不含通配符）是否合法。
 *
 * @param {string} value 小写
 * @returns {boolean}
 */
function isValidDnsName(value) {
  if (value === "" || value.length > MAX_HOSTNAME_LENGTH) return false;
  return value.split(".").every((label) => HOSTNAME_LABEL_PATTERN.test(label));
}

/**
 * 一条 DNS 类型 SAN / CN 是否匹配主机名。
 *
 * - 通配符**只允许**出现在最左一段且形态必须是 `*.`；
 *   `*.example.com` 匹配 `a.example.com`，不匹配 `a.b.example.com`、不匹配 `example.com`；
 * - 其它位置带 `*` 的模式（`a.*.com`、`*`）一律不匹配——它们不是合法模式，本层不猜意图；
 * - 大小写不敏感（两侧都已小写）。
 *
 * @param {string} hostname 已归一的小写主机名
 * @param {string} pattern SAN 或 CN 的原始取值
 * @returns {boolean}
 */
function dnsPatternMatches(hostname, pattern) {
  const text = pattern.trim().toLowerCase();
  if (text === "") return false;

  if (text.startsWith("*.")) {
    const suffix = text.slice(2);
    if (!isValidDnsName(suffix)) return false;
    const separator = hostname.indexOf(".");
    if (separator < 1) return false;
    // 只替换最左一段：剩下的部分必须与后缀**完全**相同。
    return hostname.slice(separator + 1) === suffix;
  }

  if (!isValidDnsName(text)) return false;
  return hostname === text;
}

/**
 * 从 subject 文本里取 CN。
 *
 * - 不含 `=` 的字符串整体就是 CN（`"example.com"`）；
 * - 含 `=` 的按 DN 解析，取第一个 `CN=` 组件；没有 CN 组件 → null（不把其它 RDN 当 CN）。
 *
 * @param {string | null} subject
 * @returns {string | null}
 */
function extractCommonName(subject) {
  if (typeof subject !== "string") return null;
  const text = subject.trim();
  if (text === "") return null;
  if (!text.includes("=")) return text;

  const match = COMMON_NAME_PATTERN.exec(text);
  if (match === null) return null;
  const value = match[1].trim();
  return value === "" ? null : value;
}

/**
 * 拆分归一后的 SAN 条目为 `{ type, value }`。
 *
 * @param {string} entry 形如 `"DNS:example.com"`、`"IP Address:10.0.0.1"`、`"email:a@b"`
 * @returns {{ type: string, value: string }}
 */
function splitSanEntry(entry) {
  const separator = entry.indexOf(":");
  if (separator < 0) return { type: "DNS", value: entry };
  return { type: entry.slice(0, separator), value: entry.slice(separator + 1) };
}

/**
 * 判断主机名与证书记录是否匹配。
 *
 * 返回 `true` / `false` / `null`（null = 信息不足，不猜）。
 *
 * 规则：
 *   - dNSName 类型的 SAN 优先；只要存在 dNSName，就**不**回落 CN（RFC 6125）；
 *     一条都不匹配 → false（除非 SAN 被截断，见下）；
 *   - 没有 dNSName 时回落 subject 的 CN；CN 也没有 → null；
 *   - 主机名是 IPv4 字面量时，只与 iPAddress 类型的 SAN **精确相等**（大小写不敏感），
 *     不回落 CN——现代客户端只认 iPAddress SAN，回落会产生假阳性；
 *   - 其它 SAN 类型（`email`、`URI`、`DirName`）保留但不参与匹配；
 *   - SAN 被截断（达到 MAX_SAN_ENTRIES）且没找到匹配时返回 null：
 *     读不全的列表无法证明「不在证书里」，此时给 false 等于冤枉这张证书。
 *
 * @param {unknown} record 采集层给的记录，或 parseCertificateRecord 的输出
 * @param {unknown} hostname 待匹配的主机名
 * @returns {boolean | null}
 */
export function matchesHostname(record, hostname) {
  const normalized = parseCertificateRecord(record);
  if (normalized === null) return null;
  return evaluateHostname(normalized, hostname).match;
}

/**
 * 主机名匹配的内部实现，额外带回「为什么是 null / 为什么是 false」的备注。
 *
 * @param {{ san: string[], subject: string | null }} record parseCertificateRecord 的输出
 * @param {unknown} hostname
 * @returns {{ match: boolean | null, notes: string[] }}
 */
function evaluateHostname(record, hostname) {
  if (hostname === undefined || hostname === null) {
    return { match: null, notes: [CERT_NOTES.HOSTNAME_NOT_CHECKED] };
  }

  const target = normalizeHostname(hostname);
  if (target === null) {
    return { match: null, notes: [CERT_NOTES.HOSTNAME_INVALID] };
  }

  const nameEntries = [];
  const addressEntries = [];
  for (const entry of record.san) {
    const parsed = splitSanEntry(entry);
    if (parsed.type === "DNS") nameEntries.push(parsed.value);
    else if (parsed.type === "IP Address") addressEntries.push(parsed.value);
  }

  const possiblyTruncated = record.san.length >= MAX_SAN_ENTRIES;
  const unknown = { match: null, notes: [CERT_NOTES.HOSTNAME_UNKNOWN] };
  const mismatch = { match: false, notes: [CERT_NOTES.HOSTNAME_MISMATCH] };

  if (target.kind === "ip") {
    const lower = target.value.toLowerCase();
    if (addressEntries.some((entry) => entry.trim().toLowerCase() === lower)) {
      return { match: true, notes: [] };
    }
    return possiblyTruncated ? unknown : mismatch;
  }

  if (nameEntries.length > 0) {
    if (nameEntries.some((entry) => dnsPatternMatches(target.value, entry))) {
      return { match: true, notes: [] };
    }
    return possiblyTruncated ? unknown : mismatch;
  }

  const commonName = extractCommonName(record.subject);
  if (commonName === null) return unknown;
  if (dnsPatternMatches(target.value, commonName)) return { match: true, notes: [] };
  return possiblyTruncated ? unknown : mismatch;
}

/**
 * 生成证书结论。
 *
 * 判定顺序（时间维度）：record 读不懂 → invalid；notAfter 缺失 → unknown；
 * notAfter / notBefore 读不懂 → invalid；notAfter 早于 notBefore → invalid；
 * now 缺失或读不懂 → unknown（本层不读系统时钟，时间基准必须由调用方注入）；
 * 已过期 → expired；剩余 ≤ warnDays → expiring；否则 ok。
 *
 * 主机名维度在时间维度之后叠加：给了 hostname 且 `hostnameMatches === false` →
 * 一律 invalid（名字对不上是硬失败，与到期无关）；`=== null` 只记 note，不改结论。
 *
 * @param {unknown} record 采集层给的记录，或 parseCertificateRecord 的输出
 * @param {{ now: unknown, warnDays?: number, hostname?: unknown }} [options]
 * @returns {{ verdict: string, daysRemaining: number | null,
 *   hostnameMatches: boolean | null, notes: string[] }}
 * @throws {TypeError} options 不是对象，或 warnDays 不是正有限数时
 */
export function summarizeCertificate(record, options = {}) {
  if (options === null || typeof options !== "object") {
    throw new TypeError("summarizeCertificate() expects an options object");
  }

  const warnDays = options.warnDays === undefined ? DEFAULT_WARN_DAYS : options.warnDays;
  if (!Number.isFinite(warnDays) || warnDays <= 0) {
    throw new TypeError("summarizeCertificate() warnDays must be a positive finite number");
  }

  const notes = [];
  const pushNote = (note) => {
    // 去重：同一原因即使在多条路径上命中，也只出现一次。
    if (!notes.includes(note)) notes.push(note);
  };

  if (!isPlainObject(record)) {
    pushNote(CERT_NOTES.RECORD_MISSING);
    return {
      verdict: CERT_VERDICTS.UNKNOWN,
      daysRemaining: null,
      hostnameMatches: null,
      notes
    };
  }

  const normalized = parseCertificateRecord(record);
  if (normalized === null) {
    pushNote(CERT_NOTES.RECORD_UNREADABLE);
    return {
      verdict: CERT_VERDICTS.UNKNOWN,
      daysRemaining: null,
      hostnameMatches: null,
      notes
    };
  }

  if (record.parsed === false) pushNote(CERT_NOTES.RECORD_INVALID);

  const notAfter = readTimestampField(record.notAfter);
  const notBefore = readTimestampField(record.notBefore);
  if (notAfter.status === "missing") pushNote(CERT_NOTES.NOT_AFTER_MISSING);
  if (notAfter.status === "invalid") pushNote(CERT_NOTES.NOT_AFTER_INVALID);
  if (notBefore.status === "missing") pushNote(CERT_NOTES.NOT_BEFORE_MISSING);
  if (notBefore.status === "invalid") pushNote(CERT_NOTES.NOT_BEFORE_INVALID);

  const nowField = options.now === undefined ? undefined : options.now;
  const nowTime = nowField === undefined ? null : parseTimestampValue(nowField);
  if (nowField === undefined) pushNote(CERT_NOTES.NOW_MISSING);
  else if (nowTime === null) pushNote(CERT_NOTES.NOW_INVALID);

  let verdict = CERT_VERDICTS.UNKNOWN;
  let daysRemaining = null;

  if (notAfter.status === "invalid" || notBefore.status === "invalid") {
    verdict = CERT_VERDICTS.INVALID;
  } else if (notAfter.status === "missing") {
    verdict = CERT_VERDICTS.UNKNOWN;
  } else if (nowTime === null) {
    verdict = CERT_VERDICTS.UNKNOWN;
  } else {
    const notAfterTime = parseTimestampValue(normalized.notAfter);
    const notBeforeTime =
      notBefore.status === "valid" ? parseTimestampValue(normalized.notBefore) : null;
    daysRemaining = Math.floor((notAfterTime - nowTime) / MS_PER_DAY);

    if (notBeforeTime !== null && notBeforeTime > notAfterTime) {
      pushNote(CERT_NOTES.RANGE_INVALID);
      verdict = CERT_VERDICTS.INVALID;
    } else if (notAfterTime <= nowTime) {
      pushNote(CERT_NOTES.EXPIRED);
      verdict = CERT_VERDICTS.EXPIRED;
    } else if (daysRemaining <= warnDays) {
      pushNote(CERT_NOTES.EXPIRING);
      verdict = CERT_VERDICTS.EXPIRING;
    } else {
      verdict = CERT_VERDICTS.OK;
    }
  }

  // 采集层明确说「解析失败」时，不采信本层从残片里读到的日期：一律 invalid。
  if (record.parsed === false) verdict = CERT_VERDICTS.INVALID;

  const hostnameResult = evaluateHostname(normalized, options.hostname);
  for (const note of hostnameResult.notes) pushNote(note);
  if (hostnameResult.match === false) verdict = CERT_VERDICTS.INVALID;

  return {
    verdict,
    daysRemaining,
    hostnameMatches: hostnameResult.match,
    notes
  };
}

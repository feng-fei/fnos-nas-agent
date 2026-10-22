/**
 * Phase 195 — 升级检查与版本比较（纯函数）
 *
 * 本层只回答一个问题：给定「当前版本」与「候选最新版本」，该不该提示升级？
 * 它不联网、不读文件、不接触 FPK 包与 manifest 路径，也不决定 latest 从哪来；
 * 真正的拉取（官方源、FPK 仓库、镜像）留给调用方。
 *
 * 红线：
 *   - 零 I/O、零依赖、零 import；
 *   - 解析不了就返回 null / status "unknown"，绝不把未知说成「已是最新」；
 *   - compareVersions 遇到非法版本直接抛 TypeError，不猜顺序；
 *   - build 元数据参与解析但不参与比较（SemVer 2.0.0：build 不影响优先级）；
 *   - 版本数字段遵守 SemVer：不允许前导零，且必须落在安全整数范围内；
 *   - channel 只做白名单校验与透传，不参与比较（版本串本身不带通道标记）。
 */

/** 允许的升级通道；默认 stable。 */
export const UPDATE_CHANNELS = Object.freeze(["stable", "beta", "any"]);

/** 默认升级通道。 */
export const DEFAULT_UPDATE_CHANNEL = "stable";

/** 升级结论取值。 */
export const UPDATE_STATUSES = Object.freeze({
  UP_TO_DATE: "up-to-date",
  UPDATE_AVAILABLE: "update-available",
  UNKNOWN: "unknown"
});

/** 结论备注（稳定标识，便于日志与断言）。 */
export const UPDATE_NOTES = Object.freeze({
  CURRENT_MISSING: "current-missing",
  CURRENT_INVALID: "current-invalid",
  LATEST_MISSING: "latest-missing",
  LATEST_INVALID: "latest-invalid",
  DOWNGRADE_NOT_OFFERED: "downgrade-not-offered"
});

/**
 * 语义化版本正则：`x.y.z`，可选 `-pre`，可选 `+build`。
 *
 * 捕获组依次为：1=major、2=minor、3=patch、4=pre、5=build。
 * 它只匹配「规范化之后」的字符串（不含前后空白、不含 v 前缀）；
 * 宽容入口见 parseVersion()。
 *
 * 规则（SemVer 2.0.0）：
 *   - major/minor/patch 是十进制非负整数且不允许前导零（`01.2.3` 不合法）；
 *   - pre 由 `.` 分隔的标识符组成：纯数字段不允许前导零，含字母/连字符的段
 *     按字母数字处理（`0`、`alpha`、`rc.1`、`x-y` 都合法）；
 *   - build 同样按 `.` 分隔，但允许前导零（`+build.01` 合法），且不参与比较。
 */
export const VERSION_PATTERN = new RegExp(
  "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)" +
    "(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)" +
    "(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?" +
    "(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$"
);

/** 纯数字标识符（pre 段用）。 */
const NUMERIC_IDENTIFIER_PATTERN = /^\d+$/;

/**
 * 把十进制数字段转成 Number。超出安全整数范围时返回 null，
 * 而不是一个已经丢精度的近似值——比较两个被截断的数字等于猜测。
 *
 * @param {string} text
 * @returns {number | null}
 */
function parseNumericSegment(text) {
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * 解析单个版本字符串。
 *
 * - 允许前后空白，允许 `v` / `V` 前缀（`v1.2.3`、` V1.2.3 ` 都接受）；
 * - `raw` 保留**调用方传进来的原始字符串**（含空白与 v 前缀），用于审计；
 * - 非字符串、空串、缺段、非数字段、前导零、预发布为空、超出安全整数 → null；
 * - 不抛错：解析失败统一用 null 表示。
 *
 * @param {unknown} text
 * @returns {{ major: number, minor: number, patch: number,
 *   pre: string | null, build: string | null, raw: string } | null}
 */
export function parseVersion(text) {
  if (typeof text !== "string") return null;

  const raw = text;
  const trimmed = text.trim();
  if (trimmed === "") return null;

  // 只在前缀 v 后面紧跟数字时才剥离，避免把 "version1.2.3" 误当成版本。
  const normalized = /^[vV](?=\d)/.test(trimmed) ? trimmed.slice(1) : trimmed;
  const match = VERSION_PATTERN.exec(normalized);
  if (match === null) return null;

  const major = parseNumericSegment(match[1]);
  const minor = parseNumericSegment(match[2]);
  const patch = parseNumericSegment(match[3]);
  if (major === null || minor === null || patch === null) return null;

  return {
    major,
    minor,
    patch,
    pre: match[4] ?? null,
    build: match[5] ?? null,
    raw
  };
}

/**
 * 比较两个非负十进制整数字符串的大小（不转 Number，避免溢出）。
 * 调用方保证入参匹配 /^\d+$/ 且没有前导零。
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
function compareNumericStrings(a, b) {
  if (a === b) return 0;
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : 1;
}

/**
 * 按 SemVer 2.0.0 比较两段预发布标识（都不为空）。
 *
 * - 逐段比较，数字段按数值、字母段按字典序（ASCII 码元序）；
 * - 数字段低于字母段（`1.0.0-1` < `1.0.0-alpha`）；
 * - 前缀相同则段数少的更低（`alpha` < `alpha.1`）。
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
function comparePrerelease(a, b) {
  const left = a.split(".");
  const right = b.split(".");
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    if (index >= left.length) return -1;
    if (index >= right.length) return 1;

    const leftPart = left[index];
    const rightPart = right[index];
    const leftNumeric = NUMERIC_IDENTIFIER_PATTERN.test(leftPart);
    const rightNumeric = NUMERIC_IDENTIFIER_PATTERN.test(rightPart);

    if (leftNumeric && rightNumeric) {
      const result = compareNumericStrings(leftPart, rightPart);
      if (result !== 0) return result;
      continue;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 比较两个已解析版本（内部使用）。
 *
 * build 元数据被忽略：`1.2.3+aaa` 与 `1.2.3+bbb` 相等。
 *
 * @param {{ major: number, minor: number, patch: number, pre: string | null }} a
 * @param {{ major: number, minor: number, patch: number, pre: string | null }} b
 * @returns {-1 | 0 | 1}
 */
function compareParsedVersions(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  if (a.pre === null && b.pre === null) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return comparePrerelease(a.pre, b.pre);
}

/**
 * 比较两个版本字符串：a < b → -1，相等 → 0，a > b → 1。
 *
 * **任一参数无法解析就抛 TypeError，不猜顺序。** 预发布版本低于同号正式版；
 * build 元数据不参与比较。
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {-1 | 0 | 1}
 * @throws {TypeError} 任一侧不是合法版本时
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) {
    const which = left === null ? "first" : "second";
    throw new TypeError(`compareVersions() requires two valid semantic versions; the ${which} argument is invalid`);
  }
  return compareParsedVersions(left, right);
}

/**
 * 候选版本是否比当前版本更新。
 *
 * 只有**两侧都能解析且 latest > current** 才返回 true；任一侧非法、缺字段、
 * 传入非对象，一律返回 false。注意 false 同时覆盖「已是最新」与「不知道」，
 * 调用方不能据此声称「已是最新」——要区分请用 buildUpdateVerdict()。
 *
 * @param {unknown} options
 * @returns {boolean}
 */
export function isNewerAvailable(options = {}) {
  if (options === null || typeof options !== "object") return false;
  const { current, latest } = options;
  const currentVersion = parseVersion(current);
  const latestVersion = parseVersion(latest);
  if (currentVersion === null || latestVersion === null) return false;
  return compareParsedVersions(latestVersion, currentVersion) > 0;
}

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
 * 版本的可比较指纹（用于判断题面里两个嵌套版本是否其实相同）。
 *
 * @param {{ major: number, minor: number, patch: number, pre: string | null, build: string | null }} parsed
 * @returns {string}
 */
function versionKey(parsed) {
  const pre = parsed.pre === null ? "" : `-${parsed.pre}`;
  const build = parsed.build === null ? "" : `+${parsed.build}`;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}${pre}${build}`;
}

/**
 * 从 FPK manifest 中取版本。
 *
 * 入参可以是 JSON 文本，也可以是已解析的普通对象（方便调用方复用
 * JSON.parse 结果）。查找顺序：
 *   1. 根对象的 `version`；
 *   2. 根对象下一层子对象里的 `version`（只下探一层）。
 *
 * 失败一律返回 null：非法 JSON、根不是对象、缺字段、version 非字符串、
 * 版本不合法、嵌套超过一层、多个子对象给出**不同**版本（歧义）。
 * 多个子对象给出同一个版本时不算歧义。
 *
 * @param {unknown} input
 * @returns {{ major: number, minor: number, patch: number,
 *   pre: string | null, build: string | null, raw: string } | null}
 */
export function parseManifestVersion(input) {
  let document;
  if (typeof input === "string") {
    const text = input.trim();
    if (text === "") return null;
    try {
      document = JSON.parse(text);
    } catch {
      return null;
    }
  } else {
    document = input;
  }

  if (!isPlainObject(document)) return null;

  const direct = parseVersion(document.version);
  if (direct !== null) return direct;

  const candidates = [];
  for (const value of Object.values(document)) {
    if (!isPlainObject(value)) continue;
    const parsed = parseVersion(value.version);
    if (parsed !== null) candidates.push(parsed);
  }
  if (candidates.length === 0) return null;

  // 不猜：多个子对象给出不同版本时视为歧义；相同版本则没有问题。
  const distinct = new Set(candidates.map(versionKey));
  if (distinct.size !== 1) return null;
  return candidates[0];
}

/**
 * 判断版本串是否算「没给」：undefined / null / 空白字符串。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isMissingVersion(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * 回显输入版本：字符串原样保留，非字符串统一为 null，保证结论可序列化。
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function echoVersion(value) {
  return typeof value === "string" ? value : null;
}

/**
 * 生成升级结论。
 *
 * 规则：
 *   - 任一侧无法解析 → `unknown`，notes 写明 `current-invalid` /
 *     `latest-invalid` / `current-missing` / `latest-missing`；
 *   - 两侧相等 → `up-to-date`；latest 更新 → `update-available`；
 *   - latest 更旧 → `unknown` + `downgrade-not-offered`（不提供降级）；
 *   - `channel` 只接受 stable|beta|any（默认 stable），非法值抛 TypeError；
 *     它只做白名单校验与透传，不参与比较。
 *
 * @param {unknown} options
 * @returns {{ status: "up-to-date" | "update-available" | "unknown",
 *   current: string | null, latest: string | null, channel: string, notes: string[] }}
 * @throws {TypeError} options 不是对象，或 channel 非法时
 */
export function buildUpdateVerdict(options = {}) {
  if (options === null || typeof options !== "object") {
    throw new TypeError("buildUpdateVerdict() expects an options object");
  }

  const channel = options.channel === undefined ? DEFAULT_UPDATE_CHANNEL : options.channel;
  if (!UPDATE_CHANNELS.includes(channel)) {
    throw new TypeError(`buildUpdateVerdict() channel must be one of: ${UPDATE_CHANNELS.join(", ")}`);
  }

  const { current, latest } = options;
  const currentVersion = parseVersion(current);
  const latestVersion = parseVersion(latest);
  const notes = [];

  if (currentVersion === null) {
    notes.push(isMissingVersion(current) ? UPDATE_NOTES.CURRENT_MISSING : UPDATE_NOTES.CURRENT_INVALID);
  }
  if (latestVersion === null) {
    notes.push(isMissingVersion(latest) ? UPDATE_NOTES.LATEST_MISSING : UPDATE_NOTES.LATEST_INVALID);
  }

  let status = UPDATE_STATUSES.UNKNOWN;
  if (currentVersion !== null && latestVersion !== null) {
    const comparison = compareParsedVersions(latestVersion, currentVersion);
    if (comparison === 0) {
      status = UPDATE_STATUSES.UP_TO_DATE;
    } else if (comparison > 0) {
      status = UPDATE_STATUSES.UPDATE_AVAILABLE;
    } else {
      notes.push(UPDATE_NOTES.DOWNGRADE_NOT_OFFERED);
    }
  }

  return {
    status,
    current: echoVersion(current),
    latest: echoVersion(latest),
    channel,
    notes
  };
}

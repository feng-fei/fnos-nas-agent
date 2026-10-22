/**
 * Phase 189 — 批量重命名（能力矩阵 F10）规划器与可回滚执行骨架。
 *
 * 本模块只做两件事：
 * 1. planBatchRename：把「条目 + 规则」规划成 rename 计划，并列出冲突与跳过项；
 * 2. applyBatchRenamePlan：按计划顺序调用注入的 rename(from, to)，任一步失败逆序回滚。
 *
 * 红线：模块自身不做任何 I/O，也不导入 fs / child_process；真正落盘由调用方注入，
 * 目录部分逐字节保留，只替换 basename。
 */

export const BATCH_RENAME_MODES = Object.freeze([
  "replace",
  "prefix-suffix",
  "sequence",
  "normalize",
]);

const DEFAULT_MAX_ENTRIES = 200;
const PATH_SEPARATOR = /[/\\]/;
const CLAIM_SEPARATOR = "\u0000";

function isObjectLike(value) {
  return value !== null && typeof value === "object";
}

function toInteger(value, fallback) {
  return Number.isInteger(value) ? value : fallback;
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error !== "") return error;
  const message = isObjectLike(error) ? error.message : undefined;
  if (typeof message === "string" && message !== "") return message;
  return String(error);
}

/** 按最后一个 / 或 \ 拆分，dir 保留原始分隔符与结尾分隔符。 */
function splitEntryPath(path) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index === -1) return { dir: "", base: path };
  return { dir: path.slice(0, index + 1), base: path.slice(index + 1) };
}

/**
 * 读取条目并校验结构；name 必须等于 path 的 basename，避免计划与磁盘真实名称错位。
 * 结构非法返回 null（由调用方记为 skipped invalid-entry）。
 */
function readEntry(entry) {
  if (!isObjectLike(entry)) return null;
  if (typeof entry.path !== "string" || entry.path === "") return null;
  const { dir, base } = splitEntryPath(entry.path);
  if (base === "" || base === "." || base === "..") return null;
  const name = typeof entry.name === "string" ? entry.name : base;
  if (name === "" || PATH_SEPARATOR.test(name) || name !== base) return null;
  return { path: entry.path, name, kind: entry.kind === "dir" ? "dir" : "file", dir };
}

function skippedEntryPath(entry) {
  if (isObjectLike(entry) && typeof entry.path === "string") return entry.path;
  return "";
}

/** 归一化规则：非法规则返回 error，合法规则补全默认值。 */
function readRule(rule) {
  if (!isObjectLike(rule)) {
    return { error: { code: "invalid-rule", message: "rule must be an object" } };
  }
  const mode = typeof rule.mode === "string" ? rule.mode : "";
  if (!BATCH_RENAME_MODES.includes(mode)) {
    return {
      error: { code: "invalid-mode", message: `unsupported batch rename mode: ${String(rule.mode)}` },
    };
  }
  if (mode === "replace") {
    const find = typeof rule.find === "string" ? rule.find : "";
    if (find === "") {
      return { error: { code: "empty-find", message: "replace mode requires a non-empty find string" } };
    }
    return {
      rule: {
        mode,
        find,
        replace: typeof rule.replace === "string" ? rule.replace : "",
        caseSensitive: rule.caseSensitive !== false,
      },
    };
  }
  if (mode === "prefix-suffix") {
    return {
      rule: {
        mode,
        prefix: typeof rule.prefix === "string" ? rule.prefix : "",
        suffix: typeof rule.suffix === "string" ? rule.suffix : "",
      },
    };
  }
  if (mode === "sequence") {
    return {
      rule: {
        mode,
        start: toInteger(rule.start, 1),
        step: toInteger(rule.step, 1),
        width: Math.max(0, toInteger(rule.width, 3)),
        separator: typeof rule.separator === "string" ? rule.separator : "-",
        keepExtension: rule.keepExtension !== false,
      },
    };
  }
  return {
    rule: {
      mode,
      lowercase: rule.lowercase !== false,
      spacesTo: typeof rule.spacesTo === "string" ? rule.spacesTo : "-",
      trim: rule.trim !== false,
    },
  };
}

/** 字面量替换（split/join），不把 find 当正则解释。 */
function replaceLiteral(name, find, replacement) {
  return name.split(find).join(replacement);
}

/**
 * 大小写不敏感的字面量替换。若 find 的大小写折叠会改变长度（如某些 Unicode 字符），
 * 退回大小写敏感替换以保证结果确定，不做模糊匹配。
 */
function replaceLiteralIgnoreCase(name, find, replacement) {
  const lowerName = name.toLowerCase();
  const lowerFind = find.toLowerCase();
  if (lowerFind.length !== find.length) {
    return replaceLiteral(name, find, replacement);
  }
  let result = "";
  let cursor = 0;
  let index = lowerName.indexOf(lowerFind, cursor);
  while (index !== -1) {
    result += name.slice(cursor, index) + replacement;
    cursor = index + find.length;
    index = lowerName.indexOf(lowerFind, cursor);
  }
  return result + name.slice(cursor);
}

/**
 * sequence 语义：编号追加在 basename 末尾（stem + separator + 序号 + ext）。
 * keepExtension 仅对 kind=file 生效；编号取自 entries 下标，保证与顺序一一对应。
 */
function sequenceName(entry, rule, index) {
  const serial = String(rule.start + rule.step * index).padStart(rule.width, "0");
  const suffixed = entry.name + rule.separator + serial;
  if (!rule.keepExtension || entry.kind !== "file") return suffixed;
  const dot = entry.name.lastIndexOf(".");
  if (dot <= 0) return suffixed;
  return entry.name.slice(0, dot) + rule.separator + serial + entry.name.slice(dot);
}

/** normalize 语义：先 trim，再把连续空白压成一个 spacesTo，最后按需小写。 */
function normalizeName(name, rule) {
  let next = rule.trim ? name.trim() : name;
  next = next.replace(/\s+/gu, rule.spacesTo);
  if (rule.lowercase) next = next.toLowerCase();
  return next;
}

function targetNameFor(entry, rule, index) {
  if (rule.mode === "replace") {
    return rule.caseSensitive
      ? replaceLiteral(entry.name, rule.find, rule.replace)
      : replaceLiteralIgnoreCase(entry.name, rule.find, rule.replace);
  }
  if (rule.mode === "prefix-suffix") {
    return rule.prefix + entry.name + rule.suffix;
  }
  if (rule.mode === "sequence") {
    return sequenceName(entry, rule, index);
  }
  return normalizeName(entry.name, rule);
}

/** 结果名红线检查：empty-name / path-separator / dot-dot。 */
function classifyTargetName(name) {
  if (name === "") {
    return { code: "empty-name", message: "resulting name is empty" };
  }
  if (PATH_SEPARATOR.test(name)) {
    return { code: "path-separator", message: "resulting name contains a path separator" };
  }
  if (name === "." || name === "..") {
    return { code: "dot-dot", message: "resulting name is a dot reference" };
  }
  return null;
}

function emptyPlanResult() {
  return {
    ok: false,
    errors: [],
    plan: [],
    conflicts: [],
    skipped: [],
    summary: { total: 0, planned: 0, skipped: 0, conflicts: 0 },
  };
}

/**
 * 批量重命名规划器（纯函数、零 I/O）。
 *
 * 处理顺序：结构校验（invalid-entry 跳过）→ 结果名红线（冲突）→ noop 跳过 →
 * 计划内重复目标（duplicate-target）→ 与同目录既有名称重名（target-exists）。
 * 冲突一律使 ok=false 且不进入 plan；输出顺序与 entries 一致。
 */
export function planBatchRename(entries, rule, options = {}) {
  const result = emptyPlanResult();
  if (!Array.isArray(entries)) {
    result.errors.push({ code: "invalid-entries", message: "entries must be an array" });
    return result;
  }
  result.summary.total = entries.length;

  const normalizedOptions = isObjectLike(options) ? options : {};
  const maxEntries =
    Number.isInteger(normalizedOptions.maxEntries) && normalizedOptions.maxEntries >= 0
      ? normalizedOptions.maxEntries
      : DEFAULT_MAX_ENTRIES;
  if (entries.length > maxEntries) {
    result.errors.push({
      code: "too-many-entries",
      message: `entries length ${entries.length} exceeds maxEntries ${maxEntries}`,
    });
    return result;
  }

  const parsedRule = readRule(rule);
  if (parsedRule.error) {
    result.errors.push(parsedRule.error);
    return result;
  }
  const normalizedRule = parsedRule.rule;

  // 同目录既有名称快照（按 path 的 basename 建立，用于 target-exists 判定）。
  const occupantsByDir = new Map();
  for (const entry of entries) {
    if (!isObjectLike(entry) || typeof entry.path !== "string" || entry.path === "") continue;
    const { dir, base } = splitEntryPath(entry.path);
    if (base === "") continue;
    if (!occupantsByDir.has(dir)) occupantsByDir.set(dir, new Map());
    const occupants = occupantsByDir.get(dir);
    if (!occupants.has(base)) occupants.set(base, []);
    occupants.get(base).push(entry.path);
  }

  const claimed = new Map();
  entries.forEach((entry, index) => {
    const record = readEntry(entry);
    if (!record) {
      result.skipped.push({ path: skippedEntryPath(entry), reason: "invalid-entry" });
      return;
    }
    const nextName = targetNameFor(record, normalizedRule, index);
    const violation = classifyTargetName(nextName);
    if (violation) {
      result.conflicts.push({
        kind: violation.code,
        path: record.path,
        detail: violation.message,
      });
      return;
    }
    if (nextName === record.name) {
      result.skipped.push({ path: record.path, reason: "noop" });
      return;
    }
    const claimKey = record.dir + CLAIM_SEPARATOR + nextName;
    const plannedOwner = claimed.get(claimKey);
    if (plannedOwner !== undefined) {
      result.conflicts.push({
        kind: "duplicate-target",
        path: record.path,
        detail: `target ${nextName} is already planned for ${plannedOwner}`,
      });
      return;
    }
    const occupants = occupantsByDir.get(record.dir);
    const holders = occupants ? occupants.get(nextName) : undefined;
    if (holders && holders.some((holder) => holder !== record.path)) {
      result.conflicts.push({
        kind: "target-exists",
        path: record.path,
        detail: `target ${nextName} already exists in the same directory`,
      });
      return;
    }
    claimed.set(claimKey, record.path);
    result.plan.push({ from: record.path, to: record.dir + nextName });
  });

  result.summary.planned = result.plan.length;
  result.summary.skipped = result.skipped.length;
  result.summary.conflicts = result.conflicts.length;
  result.ok = result.errors.length === 0 && result.conflicts.length === 0;
  return result;
}

function planNotApplicableError() {
  const error = new Error("batch rename plan is not applicable");
  error.code = "plan-not-applicable";
  return error;
}

function readSteps(plan) {
  if (!Array.isArray(plan.plan)) {
    throw new TypeError("applyBatchRenamePlan requires plan.plan to be an array");
  }
  return plan.plan.map((step) => {
    if (!isObjectLike(step) || typeof step.from !== "string" || typeof step.to !== "string") {
      throw new TypeError("applyBatchRenamePlan requires every step to have string from and to");
    }
    return { from: step.from, to: step.to };
  });
}

/**
 * 执行规划器产出的计划。
 *
 * 正向按 plan 顺序调用注入的 rename(from, to)；任一步失败后，已成功项逆序回滚
 * （同一 rename 反向 from/to）。回滚失败绝不静默，逐条记录在 rollbackFailures。
 * applied 记录正向成功次数（含随后被回滚的），rolledBack 记录成功回滚次数。
 */
export async function applyBatchRenamePlan(plan, options = {}) {
  const rename = isObjectLike(options) ? options.rename : undefined;
  if (typeof rename !== "function") {
    throw new TypeError("applyBatchRenamePlan requires an injected rename(from, to) function");
  }
  if (!isObjectLike(plan)) {
    throw new TypeError("applyBatchRenamePlan requires a plan object");
  }
  if (plan.ok !== true) throw planNotApplicableError();
  const steps = readSteps(plan);

  const executed = [];
  let failed = null;
  for (const step of steps) {
    try {
      await rename(step.from, step.to);
      executed.push(step);
    } catch (error) {
      failed = { from: step.from, to: step.to, message: errorMessage(error) };
      break;
    }
  }

  const rollbackFailures = [];
  let rolledBack = 0;
  if (failed !== null) {
    for (let index = executed.length - 1; index >= 0; index -= 1) {
      const step = executed[index];
      try {
        await rename(step.to, step.from);
        rolledBack += 1;
      } catch (error) {
        rollbackFailures.push({
          from: step.to,
          to: step.from,
          source: { from: step.from, to: step.to },
          message: errorMessage(error),
        });
      }
    }
  }

  return { applied: executed.length, failed, rolledBack, rollbackFailures };
}

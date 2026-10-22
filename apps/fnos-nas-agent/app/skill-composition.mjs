/**
 * Phase 209 — 技能组合（Skill composition）
 *
 * Marvis 清单 SK04「技能组合」、W15「工作流复用」与 SK06「技能权限声明」的
 * 纯函数层。组合是一份可复用的步骤清单：每一步引用一个技能、声明自己依赖
 * 哪些步骤、带上技能的输入，并可以按运行时事实决定是否执行。
 *
 * 设计原则（与仓库既有模块一致）：
 *   - 纯逻辑、零第三方依赖、ESM；本模块没有任何 import；
 *   - 不读文件、不读环境变量、不发网络请求、不执行子进程、不拼接 shell；
 *   - 不修改入参：规范化结果是新的对象，输入里的数组/对象不会被写回；
 *   - 组合永远不能「提权」：某一步需要 destructive，整个组合的有效权限
 *     就必须是 destructive。`mergeCompositionPermissions` 取的是最大值，
 *     不是组织者声明的那个更低的等级（见该函数上方注释与测试）。
 */

/** 单个组合允许的最大步骤数；超过时规范化直接拒绝，不做静默截断。 */
export const MAX_COMPOSITION_STEPS = 20;
/** 依赖链允许的最大深度（边数）；超过只产生 warning，不阻塞。 */
export const MAX_COMPOSITION_DEPTH = 3;
/** 权限等级，从低到高。 */
export const PERMISSION_LEVELS = Object.freeze(["read-only", "write", "destructive"]);

const PERMISSION_RANK = new Map(PERMISSION_LEVELS.map((level, index) => [level, index]));
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FACT_PATH_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const MAX_COMPOSITION_ID = 64;
const MAX_NAME = 100;
const MAX_DESCRIPTION = 500;
const MAX_FIELD = 128;
const MAX_INPUT_DEPTH = 8;
const MAX_ERRORS = 100;
const MAX_WARNINGS = 50;
const MAX_REQUIRED_INPUTS = 50;
const MAX_REFERENCE_DEPTH = 8;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, max) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function overlong(value, max) {
  return typeof value === "string" && value.trim().length > max;
}

/**
 * 深拷贝组合里的 JSON 风格数据。函数、Symbol、BigInt、非普通对象一律变 null；
 * 循环引用按 null 处理；超过深度上限的嵌套也变 null。输入契约就是 JSON，
 * 这里只是保证结果不再和调用方共享可变引用。
 */
function cloneValue(value, depth = 0, ancestors = new WeakSet()) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") return Number.isFinite(value) ? value : null;
  if (type !== "object") return null;
  if (depth >= MAX_INPUT_DEPTH || ancestors.has(value)) return null;
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) return null;
  ancestors.add(value);
  let output;
  if (isArray) {
    output = value.map((item) => cloneValue(item, depth + 1, ancestors));
  } else {
    output = {};
    for (const key of Object.keys(value)) {
      if (!key || key.length > 128) continue;
      // defineProperty 而不是赋值：JSON 里的 "__proto__" 不能改写结果原型。
      Object.defineProperty(output, key, {
        value: cloneValue(value[key], depth + 1, ancestors),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
  }
  ancestors.delete(value);
  return output;
}

function permissionLevel(value) {
  return typeof value === "string" && PERMISSION_RANK.has(value) ? value : null;
}

function permissionMax(values) {
  let best = "read-only";
  for (const value of values) {
    const level = permissionLevel(value);
    if (level && PERMISSION_RANK.get(level) > PERMISSION_RANK.get(best)) best = level;
  }
  return best;
}

/** 从技能记录里读取它声明的权限；没有声明就是 read-only。 */
function readSkillPermission(skill) {
  const direct = permissionLevel(skill);
  if (direct) return direct;
  if (!isPlainObject(skill)) return "read-only";
  const candidates = [];
  if (typeof skill.permission === "string") candidates.push(skill.permission);
  for (const key of ["permissions", "requiredPermissions"]) {
    if (!Array.isArray(skill[key])) continue;
    for (const item of skill[key]) {
      if (typeof item === "string") candidates.push(item);
    }
  }
  return permissionMax(candidates);
}

/** 读取权限映射里的一个值：可以是等级字符串、等级数组或技能记录。 */
function readPermissionValue(value) {
  const direct = permissionLevel(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    const candidates = [];
    for (const item of value) {
      const level = permissionLevel(item);
      if (level) candidates.push(level);
    }
    return permissionMax(candidates);
  }
  if (isPlainObject(value)) return readSkillPermission(value);
  return "read-only";
}

/**
 * 规范化一份组合定义。成功返回 `{ ok: true, composition }`，失败返回
 * `{ ok: false, reason }`；reason 是稳定字符串，见文档。
 *
 * @param {unknown} input
 * @returns {{ok: true, composition: object} | {ok: false, reason: string}}
 */
export function normalizeComposition(input) {
  if (!isPlainObject(input)) return { ok: false, reason: "invalid-composition" };
  if (overlong(input.id, MAX_COMPOSITION_ID)) return { ok: false, reason: "invalid-composition-id" };
  const id = text(input.id, MAX_COMPOSITION_ID);
  if (!ID_PATTERN.test(id)) return { ok: false, reason: "invalid-composition-id" };
  const name = text(input.name, MAX_NAME) || id;
  const description = text(input.description, MAX_DESCRIPTION);

  if (!Array.isArray(input.steps)) return { ok: false, reason: "invalid-steps" };
  if (input.steps.length > MAX_COMPOSITION_STEPS) return { ok: false, reason: "too-many-steps" };

  const steps = [];
  const stepIds = new Set();
  for (const raw of input.steps) {
    if (!isPlainObject(raw)) return { ok: false, reason: "invalid-step" };
    if (overlong(raw.id, MAX_COMPOSITION_ID)) return { ok: false, reason: "invalid-step-id" };
    const stepId = text(raw.id, MAX_COMPOSITION_ID);
    if (!STEP_ID_PATTERN.test(stepId)) return { ok: false, reason: "invalid-step-id" };
    if (stepIds.has(stepId)) return { ok: false, reason: "duplicate-step" };
    stepIds.add(stepId);

    if (overlong(raw.skillId, MAX_COMPOSITION_ID)) return { ok: false, reason: "invalid-skill-id" };
    const skillId = text(raw.skillId, MAX_COMPOSITION_ID);
    if (!ID_PATTERN.test(skillId)) return { ok: false, reason: "invalid-skill-id" };

    let dependsOn = [];
    if (raw.dependsOn !== undefined && raw.dependsOn !== null) {
      if (!Array.isArray(raw.dependsOn)) return { ok: false, reason: "invalid-dependency" };
      const seen = new Set();
      for (const candidate of raw.dependsOn) {
        if (overlong(candidate, MAX_COMPOSITION_ID)) return { ok: false, reason: "invalid-dependency" };
        const dependency = text(candidate, MAX_COMPOSITION_ID);
        if (!STEP_ID_PATTERN.test(dependency)) return { ok: false, reason: "invalid-dependency" };
        if (seen.has(dependency)) continue;
        seen.add(dependency);
        dependsOn.push(dependency);
      }
    }

    if (raw.inputs !== undefined && raw.inputs !== null && !isPlainObject(raw.inputs)) {
      return { ok: false, reason: "invalid-inputs" };
    }
    const inputs = raw.inputs === undefined || raw.inputs === null
      ? {}
      : cloneValue(raw.inputs);

    let when = null;
    if (raw.when !== undefined && raw.when !== null) {
      if (!isPlainObject(raw.when)) return { ok: false, reason: "invalid-condition" };
      const field = text(raw.when.field, MAX_FIELD);
      if (!field || !Object.hasOwn(raw.when, "equals") || raw.when.equals === undefined) {
        return { ok: false, reason: "invalid-condition" };
      }
      when = { field, equals: cloneValue(raw.when.equals) };
    }

    const step = { id: stepId, skillId, dependsOn, inputs };
    if (when) step.when = when;
    steps.push(step);
  }

  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (dependency === step.id) return { ok: false, reason: "self-dependency" };
      if (!stepIds.has(dependency)) return { ok: false, reason: "unknown-dependency" };
    }
  }

  let permissions = [];
  if (input.permissions !== undefined && input.permissions !== null) {
    if (!Array.isArray(input.permissions)) return { ok: false, reason: "invalid-permissions" };
    const seen = new Set();
    for (const candidate of input.permissions) {
      if (typeof candidate !== "string" || !PERMISSION_RANK.has(candidate)) {
        return { ok: false, reason: "unknown-permission" };
      }
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      permissions.push(candidate);
    }
    permissions.sort((left, right) => PERMISSION_RANK.get(left) - PERMISSION_RANK.get(right));
  }

  return {
    ok: true,
    composition: { id, name, description, steps, permissions }
  };
}

function findCycle(nodes, edges, orderedIds) {
  const ordered = new Set(orderedIds);
  const remaining = nodes.filter((node) => !ordered.has(node.id));
  const color = new Map();
  const stack = [];
  const stackIndex = new Map();
  let found = null;

  const visit = (stepId) => {
    if (found) return;
    const state = color.get(stepId) ?? 0;
    if (state === 1) {
      const start = stackIndex.get(stepId) ?? 0;
      found = stack.slice(start).map((id) => ({ stepId: id }));
      return;
    }
    if (state === 2) return;
    color.set(stepId, 1);
    stackIndex.set(stepId, stack.length);
    stack.push(stepId);
    for (const dependency of edges.get(stepId) ?? []) {
      visit(dependency);
      if (found) break;
    }
    stack.pop();
    stackIndex.delete(stepId);
    color.set(stepId, 2);
  };

  for (const node of remaining) visit(node.id);
  return found ?? remaining.map((node) => ({ stepId: node.id }));
}

/**
 * 拓扑排序：同一层内保持步骤在组合里的声明顺序，结果稳定可复现。
 * 依赖图上未知的依赖边会被忽略；成环时返回 `cycle`，`order` 是能排出的
 * 部分顺序（调用方必须先看 cycle，不要执行这份部分顺序）。
 *
 * @param {object} composition
 * @returns {{order: string[], cycle: null | Array<{stepId: string}>}}
 */
export function topologicalOrder(composition) {
  const rawSteps = composition && Array.isArray(composition.steps) ? composition.steps : [];
  const nodes = [];
  const byId = new Map();
  for (const raw of rawSteps) {
    if (!isPlainObject(raw)) continue;
    const id = text(raw.id, MAX_COMPOSITION_ID);
    if (!id || byId.has(id)) continue;
    const dependsOn = [];
    if (Array.isArray(raw.dependsOn)) {
      const seen = new Set();
      for (const candidate of raw.dependsOn) {
        const dependency = text(candidate, MAX_COMPOSITION_ID);
        if (!dependency || seen.has(dependency)) continue;
        seen.add(dependency);
        dependsOn.push(dependency);
      }
    }
    const node = { id, position: nodes.length, dependsOn };
    byId.set(id, node);
    nodes.push(node);
  }

  const edges = new Map();
  const indegree = new Map();
  const dependents = new Map();
  for (const node of nodes) {
    edges.set(node.id, node.dependsOn.filter((dependency) => byId.has(dependency)));
    indegree.set(node.id, 0);
    dependents.set(node.id, []);
  }
  for (const node of nodes) {
    for (const dependency of edges.get(node.id)) {
      indegree.set(node.id, indegree.get(node.id) + 1);
      dependents.get(dependency).push(node.id);
    }
  }

  const ready = nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id)
    .sort((left, right) => byId.get(left).position - byId.get(right).position);
  const order = [];
  while (ready.length > 0) {
    const stepId = ready.shift();
    order.push(stepId);
    for (const dependent of dependents.get(stepId)) {
      const remaining = indegree.get(dependent) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort((left, right) => byId.get(left).position - byId.get(right).position);
      }
    }
  }

  if (order.length !== nodes.length) {
    return { order, cycle: findCycle(nodes, edges, order) };
  }
  return { order, cycle: null };
}

/** 校验器看到的步骤视图；重复 id 只保留第一次出现。 */
function collectSteps(composition) {
  const rawSteps = composition && Array.isArray(composition.steps) ? composition.steps : [];
  const steps = [];
  const duplicates = [];
  const seen = new Set();
  for (const raw of rawSteps) {
    if (!isPlainObject(raw)) continue;
    const id = text(raw.id, MAX_COMPOSITION_ID);
    if (!id) continue;
    if (seen.has(id)) {
      duplicates.push(id);
      continue;
    }
    seen.add(id);
    const dependsOn = [];
    if (Array.isArray(raw.dependsOn)) {
      const depsSeen = new Set();
      for (const candidate of raw.dependsOn) {
        const dependency = text(candidate, MAX_COMPOSITION_ID);
        if (!dependency || depsSeen.has(dependency)) continue;
        depsSeen.add(dependency);
        dependsOn.push(dependency);
      }
    }
    steps.push({
      id,
      position: steps.length,
      skillId: text(raw.skillId, MAX_COMPOSITION_ID),
      dependsOn,
      inputs: isPlainObject(raw.inputs) ? raw.inputs : {},
      inputsValid: raw.inputs === undefined || raw.inputs === null || isPlainObject(raw.inputs),
      when: isPlainObject(raw.when) ? raw.when : null,
      whenPresent: raw.when !== undefined && raw.when !== null
    });
  }
  return { steps, duplicates };
}

function buildSkillCatalog(skills) {
  const catalog = new Map();
  for (const entry of Array.isArray(skills) ? skills : []) {
    let record = null;
    if (typeof entry === "string") {
      const id = text(entry, MAX_COMPOSITION_ID);
      if (!id) continue;
      record = { id, permission: "read-only", requiredInputs: [] };
      if (!catalog.has(id)) catalog.set(id, record);
      continue;
    }
    if (!isPlainObject(entry)) continue;
    const aliases = [];
    for (const candidate of [entry.id, entry.skillId, entry.name]) {
      const alias = text(candidate, MAX_COMPOSITION_ID);
      if (alias && !aliases.includes(alias)) aliases.push(alias);
    }
    if (aliases.length === 0) continue;
    record = {
      id: aliases[0],
      permission: readSkillPermission(entry),
      requiredInputs: readRequiredInputs(entry)
    };
    for (const alias of aliases) {
      if (!catalog.has(alias)) catalog.set(alias, record);
    }
  }
  return catalog;
}

function readRequiredInputs(skill) {
  const required = [];
  if (!Array.isArray(skill.requiredInputs)) return required;
  for (const item of skill.requiredInputs.slice(0, MAX_REQUIRED_INPUTS)) {
    let name = "";
    if (typeof item === "string") name = item.trim();
    else if (isPlainObject(item) && item.required !== false) name = text(item.name, MAX_FIELD);
    if (name) required.push(name);
  }
  return required;
}

function collectInputReferences(value, path, output, depth = 0) {
  if (depth > MAX_REFERENCE_DEPTH) return;
  if (typeof value === "string") {
    const pattern = /\$\{([^}]*)\}/g;
    let found = false;
    let match = pattern.exec(value);
    while (match) {
      found = true;
      const content = match[1].trim();
      const reference = content.split(".")[0].trim();
      output.push({ path, reference });
      match = pattern.exec(value);
    }
    if (!found && value.includes("${")) output.push({ path, reference: "" });
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      collectInputReferences(value[index], `${path}[${index}]`, output, depth + 1);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      collectInputReferences(value[key], path ? `${path}.${key}` : key, output, depth + 1);
    }
  }
}

function isUpstream(targetId, step, byId) {
  const seen = new Set();
  const queue = [...step.dependsOn];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === targetId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const dependencyStep = byId.get(current);
    if (dependencyStep) queue.push(...dependencyStep.dependsOn);
  }
  return false;
}

/** 返回 null 表示条件在结构上可求值，否则返回不可达原因。 */
function conditionIssue(rawWhen, step, byId) {
  if (!isPlainObject(rawWhen)) return "when must be a plain object";
  const field = typeof rawWhen.field === "string" ? rawWhen.field.trim() : "";
  if (!field) return "when.field must be a non-empty string";
  if (!Object.hasOwn(rawWhen, "equals")) return "when.equals is required";

  if (field.includes("${") || field.includes("}")) {
    const match = /^\$\{([^}]+)\}$/.exec(field);
    if (!match) return `when.field has a malformed reference: ${field.slice(0, MAX_FIELD)}`;
    const content = match[1].trim();
    const reference = content.split(".")[0].trim();
    if (!STEP_ID_PATTERN.test(reference)) return `when.field references an invalid step id: ${reference.slice(0, MAX_COMPOSITION_ID)}`;
    if (!byId.has(reference)) return `when.field references unknown step: ${reference}`;
    if (!isUpstream(reference, step, byId)) {
      return `when.field reads ${reference}, which is not an upstream dependency of ${step.id}`;
    }
    return null;
  }

  if (field.includes("$") || /[{}]/.test(field)) {
    return `when.field contains unsupported characters: ${field.slice(0, MAX_FIELD)}`;
  }
  const first = field.split(".")[0];
  if (byId.has(first)) {
    if (!isUpstream(first, step, byId)) {
      return `when.field reads ${first}, which is not an upstream dependency of ${step.id}`;
    }
    return null;
  }
  if (!FACT_PATH_PATTERN.test(field)) return `when.field is not a valid fact path: ${field.slice(0, MAX_FIELD)}`;
  return null;
}

function dependencyDepth(steps) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const memo = new Map();
  const visiting = new Set();
  const visit = (stepId) => {
    if (memo.has(stepId)) return memo.get(stepId);
    if (visiting.has(stepId)) return 0;
    visiting.add(stepId);
    let best = 0;
    const step = byId.get(stepId);
    if (step) {
      for (const dependency of step.dependsOn) {
        if (!byId.has(dependency)) continue;
        best = Math.max(best, 1 + visit(dependency));
      }
    }
    visiting.delete(stepId);
    memo.set(stepId, best);
    return best;
  };
  let depth = 0;
  for (const step of steps) depth = Math.max(depth, visit(step.id));
  return depth;
}

/**
 * 校验一份组合。errors 的 code 只会是文档列出的七类之一；warnings 不影响 ok。
 *
 * @param {object} composition
 * @param {{skills?: Array<object|string>}} [options]
 * @returns {{ok: boolean, errors: Array<{code: string, stepId?: string, detail: string}>, warnings: Array<{code: string, detail: string}>}}
 */
export function validateComposition(composition, { skills = [] } = {}) {
  const errors = [];
  const warnings = [];
  const pushError = (entry) => {
    if (errors.length < MAX_ERRORS) errors.push(entry);
  };

  if (!isPlainObject(composition)) {
    return {
      ok: false,
      errors: [{ code: "missing-input", detail: "composition must be a plain object" }],
      warnings
    };
  }

  const { steps, duplicates } = collectSteps(composition);
  if (!Array.isArray(composition.steps)) {
    pushError({ code: "missing-input", detail: "composition.steps must be an array" });
  }
  for (const stepId of duplicates) {
    pushError({ code: "duplicate-step", stepId, detail: `step id ${stepId} is declared more than once` });
  }

  const byId = new Map(steps.map((step) => [step.id, step]));
  const { cycle } = topologicalOrder(composition);
  if (cycle) {
    pushError({
      code: "dependency-cycle",
      stepId: cycle[0]?.stepId,
      detail: `dependency cycle: ${cycle.map((entry) => entry.stepId).join(" -> ")}`
    });
  }

  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      const dependencyStep = byId.get(dependency);
      if (!dependencyStep) continue;
      if (dependencyStep.position > step.position) {
        pushError({
          code: "dependency-order",
          stepId: step.id,
          detail: `step ${step.id} declares dependency ${dependency} later in the composition`
        });
      }
    }
  }

  const catalog = buildSkillCatalog(skills);
  const resolved = new Map();
  for (const step of steps) {
    const skill = step.skillId ? catalog.get(step.skillId) : null;
    resolved.set(step.id, skill || null);
    if (!skill) {
      pushError({
        code: "unknown-skill",
        stepId: step.id,
        detail: `skill ${step.skillId || "(missing)"} is not in the provided skill list`
      });
    }
  }

  for (const step of steps) {
    if (!step.inputsValid) {
      pushError({ code: "missing-input", stepId: step.id, detail: "step inputs must be a plain object" });
      continue;
    }
    const skill = resolved.get(step.id);
    if (skill) {
      for (const name of skill.requiredInputs) {
        if (!Object.hasOwn(step.inputs, name) || step.inputs[name] === undefined) {
          pushError({
            code: "missing-input",
            stepId: step.id,
            detail: `skill ${step.skillId} requires input ${name}`
          });
        }
      }
    }
    const references = [];
    collectInputReferences(step.inputs, "inputs", references);
    for (const reference of references) {
      if (!reference.reference || !byId.has(reference.reference)) {
        pushError({
          code: "missing-input",
          stepId: step.id,
          detail: reference.reference
            ? `${reference.path} references unknown step ${reference.reference}`
            : `${reference.path} contains an unresolved input reference`
        });
      }
    }
  }

  const declared = Array.isArray(composition.permissions)
    ? composition.permissions.filter((value) => permissionLevel(value))
    : [];
  if (declared.length > 0) {
    const ceiling = permissionMax(declared);
    for (const step of steps) {
      const skill = resolved.get(step.id);
      if (!skill) continue;
      if (PERMISSION_RANK.get(skill.permission) > PERMISSION_RANK.get(ceiling)) {
        pushError({
          code: "permission-escalation",
          stepId: step.id,
          detail: `composition declares ${ceiling} but skill ${step.skillId} requires ${skill.permission}`
        });
      }
    }
  }

  for (const step of steps) {
    if (!step.whenPresent) continue;
    const issue = conditionIssue(step.when, step, byId);
    if (issue) {
      pushError({ code: "condition-unreachable", stepId: step.id, detail: issue });
    }
  }

  if (!cycle && warnings.length < MAX_WARNINGS) {
    const depth = dependencyDepth(steps);
    if (depth > MAX_COMPOSITION_DEPTH) {
      warnings.push({
        code: "dependency-depth-exceeded",
        detail: `longest dependency chain has ${depth} edges, above MAX_COMPOSITION_DEPTH=${MAX_COMPOSITION_DEPTH}`
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function readFact(facts, field) {
  if (!isPlainObject(facts)) return { exists: false, value: undefined };
  const segments = field.split(".");
  if (segments.some((segment) => !segment)) return { exists: false, value: undefined };
  let cursor = facts;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== "object" || !Object.hasOwn(cursor, segment)) {
      return { exists: false, value: undefined };
    }
    cursor = cursor[segment];
  }
  return { exists: true, value: cursor };
}

function valuesEqual(left, right, depth = 0) {
  if (Object.is(left, right)) return true;
  if (depth > MAX_INPUT_DEPTH) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (!valuesEqual(left[index], right[index], depth + 1)) return false;
    }
    return true;
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    for (const key of leftKeys) {
      if (!Object.hasOwn(right, key)) return false;
      if (!valuesEqual(left[key], right[key], depth + 1)) return false;
    }
    return true;
  }
  return false;
}

/**
 * 计划期条件求值。只读 `facts`；读取步骤输出的条件在计划阶段无法求值，
 * 一律按「未满足」处理（保守跳过，绝不乐观放行）。
 */
function conditionMatches(step, facts, byId) {
  if (!isPlainObject(step.when)) return false;
  const field = typeof step.when.field === "string" ? step.when.field.trim() : "";
  if (!field || !Object.hasOwn(step.when, "equals")) return false;
  if (field.includes("${") || /[{}]/.test(field)) return false;
  const first = field.split(".")[0];
  if (byId.has(first)) return false;
  const fact = readFact(facts, field);
  if (!fact.exists) return false;
  return valuesEqual(fact.value, step.when.equals);
}

/**
 * 把组合计划成一次运行：先算拓扑顺序，再逐个判断条件、技能能否解析、
 * 依赖是否被跳过。计划本身不执行任何技能，也不访问任何外部状态。
 *
 * skipped 的 reason：
 *   - condition-not-met：when 条件不满足（或计划期无法求值）；
 *   - unknown-skill：resolveSkill 返回空；
 *   - unknown-dependency：dependsOn 指向组合里不存在的步骤；
 *   - dependency-skipped：前置步骤被跳过；
 *   - dependency-cycle：组合依赖成环，整份计划不可运行。
 *
 * @param {object} composition
 * @param {{resolveSkill?: (skillId: string, step: object) => unknown, facts?: object}} [options]
 * @returns {{runnable: boolean, skipped: Array<{stepId: string, reason: string}>, steps: Array<{stepId: string, skillId: string, permission: string, dependsOn: string[]}>, effectivePermissions: string}}
 */
export function planCompositionRun(composition, { resolveSkill = () => null, facts = {} } = {}) {
  const { steps } = collectSteps(composition);
  const byId = new Map(steps.map((step) => [step.id, step]));
  const resolver = typeof resolveSkill === "function" ? resolveSkill : () => null;

  const resolved = new Map();
  for (const step of steps) {
    let skill = null;
    try {
      skill = resolver(step.skillId, {
        id: step.id,
        skillId: step.skillId,
        dependsOn: [...step.dependsOn],
        inputs: cloneValue(step.inputs)
      });
    } catch {
      skill = null;
    }
    resolved.set(step.id, skill || null);
  }

  // 安全红线：只要组合里任何一步的（已解析）技能需要 destructive，
  // 整份计划的有效权限就是 destructive，哪怕该步骤随后被条件跳过。
  const permissionCandidates = [];
  if (Array.isArray(composition?.permissions)) permissionCandidates.push(...composition.permissions);
  for (const step of steps) {
    permissionCandidates.push(resolved.get(step.id) ? readSkillPermission(resolved.get(step.id)) : "read-only");
  }
  const effectivePermissions = steps.length === 0 ? "read-only" : permissionMax(permissionCandidates);

  const { order, cycle } = topologicalOrder(composition);
  if (cycle) {
    return {
      runnable: false,
      skipped: steps.map((step) => ({ stepId: step.id, reason: "dependency-cycle" })),
      steps: [],
      effectivePermissions
    };
  }

  const status = new Map();
  const planned = [];
  const skipped = [];
  for (const stepId of order) {
    const step = byId.get(stepId);
    if (!step) continue;

    let reason = null;
    if (step.dependsOn.some((dependency) => !byId.has(dependency))) {
      reason = "unknown-dependency";
    } else if (step.dependsOn.some((dependency) => status.get(dependency)?.state === "skipped")) {
      reason = "dependency-skipped";
    }
    if (!reason && step.whenPresent && !conditionMatches(step, facts, byId)) {
      reason = "condition-not-met";
    }
    if (!reason && !resolved.get(step.id)) reason = "unknown-skill";

    if (reason) {
      status.set(step.id, { state: "skipped", reason });
      skipped.push({ stepId: step.id, reason });
      continue;
    }

    status.set(step.id, { state: "planned" });
    planned.push({
      stepId: step.id,
      skillId: step.skillId,
      permission: readSkillPermission(resolved.get(step.id)),
      dependsOn: [...step.dependsOn]
    });
  }

  return {
    runnable: planned.length > 0,
    skipped,
    steps: planned,
    effectivePermissions
  };
}

function lookupSkillPermission(source, skillId, stepId) {
  if (typeof source === "function") {
    try {
      return readPermissionValue(source(skillId, stepId));
    } catch {
      return "read-only";
    }
  }
  if (source instanceof Map) {
    if (source.has(skillId)) return readPermissionValue(source.get(skillId));
    if (stepId && source.has(stepId)) return readPermissionValue(source.get(stepId));
    return "read-only";
  }
  if (Array.isArray(source)) {
    for (const entry of source) {
      if (typeof entry === "string") {
        if (entry === skillId) return "read-only";
        continue;
      }
      if (!isPlainObject(entry)) continue;
      const aliases = [entry.id, entry.skillId, entry.name].filter((value) => typeof value === "string");
      if (aliases.includes(skillId) || (stepId && aliases.includes(stepId))) {
        return readSkillPermission(entry);
      }
    }
    return "read-only";
  }
  if (isPlainObject(source)) {
    if (Object.hasOwn(source, skillId)) return readPermissionValue(source[skillId]);
    if (stepId && Object.hasOwn(source, stepId)) return readPermissionValue(source[stepId]);
    return "read-only";
  }
  return "read-only";
}

/**
 * 合并组合声明的权限与每一步技能需要的权限，返回最高等级。
 *
 * 安全红线（必须保留这段注释）：这不是「取组合声明的权限」的函数。只要
 * 任何一步需要 destructive，结果就必须是 destructive；组合不能借由自己
 * 声明一个更低的权限来把破坏性步骤包装成低权限。空组合（没有 steps）
 * 没有实际动作，按约定返回 read-only。
 *
 * @param {object} composition
 * @param {Map<string, unknown>|object|Array<object|string>|Function} skillPermissions
 * @returns {"read-only"|"write"|"destructive"}
 */
export function mergeCompositionPermissions(composition, skillPermissions) {
  const rawSteps = composition && Array.isArray(composition.steps) ? composition.steps : [];
  const steps = rawSteps.filter((step) => isPlainObject(step));
  if (steps.length === 0) return "read-only";

  const candidates = [];
  if (Array.isArray(composition.permissions)) candidates.push(...composition.permissions);
  for (const step of steps) {
    const skillId = text(step.skillId, MAX_COMPOSITION_ID);
    const stepId = text(step.id, MAX_COMPOSITION_ID);
    candidates.push(lookupSkillPermission(skillPermissions, skillId, stepId));
  }
  return permissionMax(candidates);
}

/**
 * Phase 203 — 把「只开在 HTTP 上的只读事实」做成 Agent 可调用的工具定义。
 *
 * 背景：server.mjs 里已经有一批「只读、无副作用」的系统事实接口（快照、服务状态、
 * SMART、温度、事件、设备能力、容量预测），但它们只有 HTTP 出口。Agent 侧的工具
 * 注册表里没有对应条目，模型只能靠自然语言问，问不出结构化结论。本模块把七类事实
 * 做成工具定义，形状与 read-only-tools.mjs 保持一致（id / title / description /
 * risk / inputSchema / invoke），由接线方决定什么时候注册进注册表。
 *
 * 安全红线（改代码前先读，测试已锁死）：
 *
 *   1. **只读适配器，零 I/O**：本模块不读文件、不联网、不 exec 任何进程、不拼接命令，
 *      也不 import node:fs / node:child_process / node:net / node:http。真正的采集动作
 *      全部来自调用方注入的函数；本文件里只有数据整形。
 *   2. **不猜**：采集器没注入 → collector-unavailable；采集器抛错 → collector-failed；
 *      采集器返回 null → 如实返回 data: null。「没采到」永远不会被包装成「正常」。
 *   3. **值清洗**：采集器返回的对象里，键名匹配 /pass|token|secret|key/i 时，其值一律
 *      替换为 "<redacted>"，并递归进入嵌套对象与数组。规则故意做得很钝（宁可误伤
 *      passengerCount 这类名字，也不放过真凭据），因为这里面对的是模型上下文。
 *   4. **有界**：错误信息按 Unicode 码点截断到 200 字符，控制字符转空格；不把整段
 *      堆栈或原始 stdout 透给模型。
 *   5. **参数白名单**：inputSchema 是仓库现有的 JSON Schema 子集（type / properties /
 *      required / additionalProperties / minLength / maxLength / enum / minimum /
 *      maximum），多余参数与越界值在调起采集器之前就被拒绝。
 *
 * 本模块的执行语义是「先校验、再采集、再清洗」，任何一步失败都返回结构化失败对象，
 * 不抛异常 —— 工具调用链路上抛异常会把「采集不到」升级成「调用失败」，模型分不清。
 */

import { EVENT_LEVELS } from "./system-events.mjs";

/** 七个工具 id 的固定顺序；接线与文档都按这个顺序引用。 */
export const SYSTEM_TOOL_IDS = Object.freeze([
  "services.list",
  "smart.summary",
  "thermal.status",
  "events.recent",
  "snapshot.summary",
  "capabilities.get",
  "capacity.forecast"
]);

/** 工具风险等级：本模块只产出只读工具，没有第二个取值。 */
export const READ_ONLY_RISK = "read-only";

/** 敏感键名命中后替换成的占位符。 */
export const REDACTED_PLACEHOLDER = "<redacted>";

/**
 * 敏感键名规则。**故意做得很钝**：`passengerCount`、`monkey`、`keyword` 都会被误伤。
 * 这是有意的取舍 —— 工具输出会进入模型上下文，漏掉一个真凭据的代价远大于多打一次码。
 */
export const SENSITIVE_KEY_PATTERN = /pass|token|secret|key/i;

/**
 * 被钝规则误伤但必须保持可见的功能字段。`passed` 是能力体检里「这一维过没过」
 * 的结论：把它打码成 <redacted>，模型就只能看到一串星号，工具等于白给。
 * 只放「键名不是凭据、值是结论」的极少数键，不要往里塞业务字段。
 */
export const VISIBLE_KEYS = Object.freeze(new Set(["passed", "pass", "passRate", "requiredPassed"]));

/** 错误信息截断上限（Unicode 码点数，不会切断代理对）。 */
export const MAX_COLLECTOR_MESSAGE_LENGTH = 200;

/** 清洗时允许下滑的最大层数；超出的子树用 depth-limit 占位，防止深结构炸栈。 */
export const MAX_REDACTION_DEPTH = 12;

/** events.recent 的默认/最大条数，与 HTTP 路由的取值口径一致。 */
export const DEFAULT_EVENTS_LIMIT = 20;
export const MAX_EVENTS_LIMIT = 200;

/** events.recent 的 since 只是「原样透传的过滤串」，长度上限 40。 */
export const MAX_EVENTS_SINCE_LENGTH = 40;

/** capacity.forecast 的默认/最大预测天数。 */
export const DEFAULT_FORECAST_HORIZON_DAYS = 30;
export const MAX_FORECAST_HORIZON_DAYS = 365;

/** 深层结构 / 循环引用的占位符，避免清洗阶段把整个对象图展开。 */
const DEPTH_LIMIT_PLACEHOLDER = "[depth-limit]";
const CIRCULAR_PLACEHOLDER = "[circular]";

/** 控制字符（C0 与 DEL）：错误信息里的换行会把一条结果撑成多行日志。 */
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/g;

/** 无参数工具的 schema：一个不允许额外属性的空对象。 */
const NO_ARGUMENT_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({}),
  additionalProperties: false
});

/**
 * events.recent 的 schema。
 *
 * `since` 只做长度约束、不在这里解析成时间：过滤语义由采集器决定，本模块不替它
 * 猜「ISO-ish」到底是什么格式，也不把非法日期悄悄丢掉。
 */
const EVENTS_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    limit: Object.freeze({ type: "integer", minimum: 1, maximum: MAX_EVENTS_LIMIT }),
    since: Object.freeze({ type: "string", minLength: 1, maxLength: MAX_EVENTS_SINCE_LENGTH }),
    level: Object.freeze({ type: "string", enum: EVENT_LEVELS })
  }),
  additionalProperties: false
});

/** capacity.forecast 的 schema。 */
const FORECAST_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    horizonDays: Object.freeze({ type: "integer", minimum: 1, maximum: MAX_FORECAST_HORIZON_DAYS })
  }),
  additionalProperties: false
});

/**
 * 工具规格表。`collectorKey` 是注入对象的键名，`inputSchema` 与校验、转发共用同一份
 * 定义：广告给模型的 schema 与实际校验的规则不会漂移。
 */
const TOOL_SPECS = Object.freeze([
  Object.freeze({
    id: "services.list",
    title: "系统服务状态",
    description: "读取 fnOS 核心 systemd 服务的只读状态快照。unit 名单固定在服务端，调用方不能指定要查哪个 unit；采集器不可用时每条都是 unknown，不会被当成健康。",
    risk: READ_ONLY_RISK,
    collectorKey: "services",
    inputSchema: NO_ARGUMENT_SCHEMA
  }),
  Object.freeze({
    id: "smart.summary",
    title: "硬盘 SMART 健康",
    description: "读取硬盘 SMART 健康摘要（smartctl -H -A 的解析结论）。采集器默认关闭；未启用或无裸设备权限时按 unknown 上报，绝不说成健康。",
    risk: READ_ONLY_RISK,
    collectorKey: "smart",
    inputSchema: NO_ARGUMENT_SCHEMA
  }),
  Object.freeze({
    id: "thermal.status",
    title: "温度状态",
    description: "读取 /sys/class/thermal 固定 zone 的只读温度与阈值判定。读不到就是 unknown —— 没测到不等于温度正常。",
    risk: READ_ONLY_RISK,
    collectorKey: "thermal",
    inputSchema: NO_ARGUMENT_SCHEMA
  }),
  Object.freeze({
    id: "events.recent",
    title: "最近系统事件",
    description: "汇总最近的系统日志事件：级别计数与归一化后的重复分组。只解析采集器交进来的日志尾部，不读任意文件路径；没有日志时结论是 unknown 而不是「没有错误」。",
    risk: READ_ONLY_RISK,
    collectorKey: "events",
    inputSchema: EVENTS_SCHEMA
  }),
  Object.freeze({
    id: "snapshot.summary",
    title: "系统快照摘要",
    description: "读取系统快照的六个分段（处理器/内存/存储与硬盘健康/网络/服务/容器）的状态、取值与覆盖率。未采集的分段如实标注，不填默认值。",
    risk: READ_ONLY_RISK,
    collectorKey: "snapshot",
    inputSchema: NO_ARGUMENT_SCHEMA
  }),
  Object.freeze({
    id: "capabilities.get",
    title: "设备能力体检",
    description: "读取本机对某个负载档位（agent-host / local-llm）的设备能力体检结论：逐维度的 required 与 passed，不给模糊总分。",
    risk: READ_ONLY_RISK,
    collectorKey: "capabilities",
    inputSchema: NO_ARGUMENT_SCHEMA
  }),
  Object.freeze({
    id: "capacity.forecast",
    title: "容量趋势预测",
    description: "按已有容量采样推算增长趋势与容量预测。样本不足时不给写满天数；采样来自调用方交进来的历史，本工具不发命令、不读盘。",
    risk: READ_ONLY_RISK,
    collectorKey: "forecast",
    inputSchema: FORECAST_SCHEMA
  })
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 按 Unicode 码点截断，不会把代理对切成两半。 */
function truncateToCodePoints(text, maxLength) {
  const codePoints = Array.from(text);
  if (codePoints.length <= maxLength) return text;
  return codePoints.slice(0, maxLength).join("");
}

/**
 * 把抛出来的东西压成一行有界的说明。
 *
 * - `Error` 取 message（为空时退回 name）；
 * - 字符串原样用；
 * - 其它值尝试 JSON 序列化，失败再退回 String()；
 * - 控制字符（含换行）转空格，避免一条结果在日志里被撑成多行。
 */
function describeCollectorError(error) {
  let text;
  if (error instanceof Error) text = error.message || error.name || "Error";
  else if (typeof error === "string") text = error;
  else {
    try {
      const serialized = JSON.stringify(error);
      text = typeof serialized === "string" ? serialized : String(error);
    } catch {
      text = String(error);
    }
  }
  return truncateToCodePoints(String(text ?? "").replace(CONTROL_CHAR_PATTERN, " ").trim(), MAX_COLLECTOR_MESSAGE_LENGTH);
}

/**
 * 递归清洗采集结果：键名命中 SENSITIVE_KEY_PATTERN 的值换成 "<redacted>"。
 *
 * - 只重建**普通对象**与数组；Date / Map / Buffer 这类非普通对象原样透传（本模块不认识
 *   它们的内部结构，强行展开反而会改语义）；
 * - 同一对象在兄弟位置重复出现不算环（用 seen 记录当前递归路径，回溯时删除）；
 * - 真环 → "[circular]"；超过 MAX_REDACTION_DEPTH → "[depth-limit]"。
 *
 * 返回的是新对象：调用方持有的原始数据不会被就地改写。
 */
function redactSensitiveValues(value, seen = new WeakSet(), depth = 0) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return CIRCULAR_PLACEHOLDER;
  if (depth >= MAX_REDACTION_DEPTH) return DEPTH_LIMIT_PLACEHOLDER;

  if (Array.isArray(value)) {
    seen.add(value);
    const items = value.map(item => redactSensitiveValues(item, seen, depth + 1));
    seen.delete(value);
    return items;
  }

  if (!isPlainObject(value)) return value;

  seen.add(value);
  const redacted = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key) && !VISIBLE_KEYS.has(key)
      ? REDACTED_PLACEHOLDER
      : redactSensitiveValues(item, seen, depth + 1);
  }
  seen.delete(value);
  return redacted;
}

/** 值的类型判读：只需区分本仓库 schema 子集用到的几种。 */
function describeValueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * 按仓库现有的 JSON Schema 子集校验参数。
 *
 * 只实现 read-only-tools.mjs 已经在用的那几种约束，不做通用 JSON Schema：type、
 * properties、required、additionalProperties、minLength/maxLength、enum、minimum/
 * maximum。值为 `undefined` 的键按「没传」处理（JSON 里也表达不出来）。
 *
 * @param {string} id 工具 id
 * @param {unknown} [args]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateToolArguments(id, args = {}) {
  const spec = TOOL_SPECS.find(item => item.id === id);
  if (!spec) return { ok: false, errors: [`unknown-tool: ${String(id)}`] };

  const value = args ?? {};
  if (!isPlainObject(value)) {
    return { ok: false, errors: [`arguments-must-be-an-object: got ${describeValueType(value)}`] };
  }

  const errors = [];
  const { properties = {}, required = [], additionalProperties } = spec.inputSchema;
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);

  // 七个工具的 schema 都是 additionalProperties: false —— 没有白名单之外的参数。
  // 这里按 schema 取值判断，将来某个工具放宽时不必回头改校验代码。
  if (additionalProperties === false) {
    for (const [key] of entries) {
      if (!Object.hasOwn(properties, key)) errors.push(`unknown-argument: ${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) errors.push(`missing-argument: ${key}`);
  }

  for (const [key, item] of entries) {
    const rule = properties[key];
    if (!rule) continue;

    if (rule.type === "string") {
      if (typeof item !== "string") {
        errors.push(`type-mismatch: ${key} must be string`);
        continue;
      }
      if (typeof rule.minLength === "number" && item.length < rule.minLength) {
        errors.push(`length-below-minimum: ${key} needs >= ${rule.minLength}`);
      }
      if (typeof rule.maxLength === "number" && item.length > rule.maxLength) {
        errors.push(`length-above-maximum: ${key} needs <= ${rule.maxLength}`);
      }
    }

    if (rule.type === "integer") {
      if (!Number.isInteger(item)) {
        errors.push(`type-mismatch: ${key} must be integer`);
        continue;
      }
      if (typeof rule.minimum === "number" && item < rule.minimum) {
        errors.push(`below-minimum: ${key} needs >= ${rule.minimum}`);
      }
      if (typeof rule.maximum === "number" && item > rule.maximum) {
        errors.push(`above-maximum: ${key} needs <= ${rule.maximum}`);
      }
    }

    if (rule.type === "boolean" && typeof item !== "boolean") {
      errors.push(`type-mismatch: ${key} must be boolean`);
    }

    if (Array.isArray(rule.enum) && !rule.enum.includes(item)) {
      errors.push(`not-in-enum: ${key} must be one of ${rule.enum.join("|")}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 把调用方参数翻译成采集器的实参列表。
 *
 * 无参数工具调 `collector()`；带参数的两个工具调 `collector({...})`，并且**只转发
 * 调用方真正给出的过滤条件**（缺省值由本模块补，`since`/`level` 不补 null）。
 */
function collectorArguments(spec, args) {
  if (spec.id === "events.recent") {
    const forwarded = { limit: args.limit ?? DEFAULT_EVENTS_LIMIT };
    if (args.since !== undefined) forwarded.since = args.since;
    if (args.level !== undefined) forwarded.level = args.level;
    return [forwarded];
  }
  if (spec.id === "capacity.forecast") {
    return [{ horizonDays: args.horizonDays ?? DEFAULT_FORECAST_HORIZON_DAYS }];
  }
  return [];
}

/**
 * 构造七个只读工具定义。
 *
 * @param {object} [collectors]
 * @param {Function|null} [collectors.services] `() => report`
 * @param {Function|null} [collectors.smart] `() => report`
 * @param {Function|null} [collectors.thermal] `() => report`
 * @param {Function|null} [collectors.events] `({ limit, since?, level? }) => report`
 * @param {Function|null} [collectors.snapshot] `() => report`
 * @param {Function|null} [collectors.capabilities] `() => report`
 * @param {Function|null} [collectors.forecast] `({ horizonDays }) => report`
 * @returns {Array<{ id: string, title: string, description: string, risk: "read-only",
 *   inputSchema: object, invoke: (args?: object) => Promise<object> }>}
 *
 * invoke 的返回只有四种形状，全部不抛异常：
 *   - `{ ok: true, data }`                采集成功（data 已清洗；采集器返回 null 时 data: null）
 *   - `{ ok: false, reason: "collector-unavailable", id }`
 *   - `{ ok: false, reason: "collector-failed", id, message }`
 *   - `{ ok: false, reason: "invalid-arguments", id, errors }`
 */
export function createSystemToolDefinitions({
  services = null,
  smart = null,
  thermal = null,
  events = null,
  snapshot = null,
  capabilities = null,
  forecast = null
} = {}) {
  const collectors = { services, smart, thermal, events, snapshot, capabilities, forecast };

  return TOOL_SPECS.map(spec => ({
    id: spec.id,
    title: spec.title,
    description: spec.description,
    risk: spec.risk,
    inputSchema: spec.inputSchema,
    async invoke(args) {
      const normalized = args === undefined || args === null ? {} : args;
      // 参数校验先于采集器可用性：请求本身写错是调用方的问题，不该被
      // 「采集器没接」掩盖掉。
      const verdict = validateToolArguments(spec.id, normalized);
      if (!verdict.ok) {
        return { ok: false, reason: "invalid-arguments", id: spec.id, errors: verdict.errors };
      }

      const collector = collectors[spec.collectorKey];
      if (typeof collector !== "function") {
        return { ok: false, reason: "collector-unavailable", id: spec.id };
      }

      try {
        const data = await collector(...collectorArguments(spec, normalized));
        // 采集器可能同步返回、也可能返回 Promise；`await` 两种情况都覆盖。
        // 返回 undefined 时归一成 null，避免 JSON 序列化把 data 字段整个丢掉。
        return { ok: true, data: redactSensitiveValues(data === undefined ? null : data) };
      } catch (error) {
        return { ok: false, reason: "collector-failed", id: spec.id, message: describeCollectorError(error) };
      }
    }
  }));
}

/**
 * 只返回可序列化的摘要 `[{ id, title, risk }]`。
 *
 * 给「工具目录 / 模型提示词里的工具清单」这类只需要元数据的地方用：不带函数，
 * 可以安全 JSON.stringify。
 *
 * @returns {Array<{ id: string, title: string, risk: string }>}
 */
export function listSystemTools() {
  return TOOL_SPECS.map(({ id, title, risk }) => ({ id, title, risk }));
}

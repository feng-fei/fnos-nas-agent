import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createSystemToolDefinitions,
  listSystemTools,
  validateToolArguments,
  DEFAULT_EVENTS_LIMIT,
  DEFAULT_FORECAST_HORIZON_DAYS,
  MAX_COLLECTOR_MESSAGE_LENGTH,
  MAX_EVENTS_LIMIT,
  MAX_EVENTS_SINCE_LENGTH,
  MAX_FORECAST_HORIZON_DAYS,
  REDACTED_PLACEHOLDER,
  SYSTEM_TOOL_IDS
} from "../apps/fnos-nas-agent/app/system-tools.mjs";

const MODULE_PATH = fileURLToPath(new URL("../apps/fnos-nas-agent/app/system-tools.mjs", import.meta.url));

/** 按 id 取定义；id 拼错时立刻失败，而不是静默拿到 undefined。 */
function toolOf(definitions, id) {
  const definition = definitions.find(item => item.id === id);
  assert.ok(definition, `missing tool definition: ${id}`);
  return definition;
}

/** 记录调用参数的采集器替身。 */
function spy(result) {
  const calls = [];
  const collector = (...args) => {
    calls.push(args);
    return typeof result === "function" ? result(...args) : result;
  };
  collector.calls = calls;
  return collector;
}

test("system-tools: 七个工具 id 固定且顺序稳定，risk 全为 read-only", () => {
  const definitions = createSystemToolDefinitions();
  assert.equal(definitions.length, 7);
  assert.deepEqual(definitions.map(item => item.id), [...SYSTEM_TOOL_IDS]);
  assert.deepEqual([...SYSTEM_TOOL_IDS], [
    "services.list",
    "smart.summary",
    "thermal.status",
    "events.recent",
    "snapshot.summary",
    "capabilities.get",
    "capacity.forecast"
  ]);
  for (const definition of definitions) {
    assert.equal(definition.risk, "read-only", `${definition.id} must be read-only`);
  }
});

test("system-tools: 每个定义都带标题、描述、schema 与可调用的 invoke", () => {
  for (const definition of createSystemToolDefinitions()) {
    assert.equal(typeof definition.title, "string");
    assert.ok(definition.title.length > 0, `${definition.id} needs a title`);
    assert.ok(definition.description.length > 0, `${definition.id} needs a description`);
    assert.equal(typeof definition.invoke, "function");
    assert.equal(definition.inputSchema.type, "object");
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.equal(typeof definition.inputSchema.properties, "object");
    const properties = definition.inputSchema.properties;
    for (const key of definition.inputSchema.required ?? []) {
      assert.ok(Object.hasOwn(properties, key), `${definition.id} requires undeclared property ${key}`);
    }
  }
});

test("system-tools: 完全没有注入采集器时，七次调用都返回 collector-unavailable 且不抛", async () => {
  const definitions = createSystemToolDefinitions();
  for (const id of SYSTEM_TOOL_IDS) {
    const result = await toolOf(definitions, id).invoke();
    assert.deepEqual(result, { ok: false, reason: "collector-unavailable", id }, `${id} should report unavailable`);
  }
});

test("system-tools: 注入值不是函数时同样按 collector-unavailable 处理", async () => {
  const definitions = createSystemToolDefinitions({ services: "systemctl", smart: 42, thermal: {} });
  for (const id of ["services.list", "smart.summary", "thermal.status"]) {
    const result = await toolOf(definitions, id).invoke();
    assert.deepEqual(result, { ok: false, reason: "collector-unavailable", id });
  }
});

test("system-tools: 采集器抛错时返回 collector-failed，message 截断到 200 字符", async () => {
  const message = "boom ".repeat(100);
  assert.ok(message.length > MAX_COLLECTOR_MESSAGE_LENGTH);
  const definitions = createSystemToolDefinitions({
    services: () => {
      throw new Error(message);
    }
  });
  const result = await toolOf(definitions, "services.list").invoke();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "collector-failed");
  assert.equal(result.id, "services.list");
  assert.equal(result.message.length, MAX_COLLECTOR_MESSAGE_LENGTH);
  assert.equal(result.message, message.slice(0, MAX_COLLECTOR_MESSAGE_LENGTH));
});

test("system-tools: 采集器异步失败与非 Error 抛出值也被压成一行有界说明", async () => {
  const rejections = [
    async () => {
      await Promise.resolve();
      throw "boom\nline2\tend";
    },
    () => {
      throw { code: "EPERM" };
    }
  ];
  for (const collector of rejections) {
    const definitions = createSystemToolDefinitions({ services: collector });
    const result = await toolOf(definitions, "services.list").invoke();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "collector-failed");
    assert.equal(typeof result.message, "string");
    assert.ok(result.message.length <= MAX_COLLECTOR_MESSAGE_LENGTH);
    assert.ok(!result.message.includes("\n"), "control characters must be flattened");
  }

  const flat = await toolOf(createSystemToolDefinitions({
    services: () => {
      throw "boom\nline2\tend";
    }
  }), "services.list").invoke();
  assert.equal(flat.message, "boom line2 end");

  const objectThrown = await toolOf(createSystemToolDefinitions({
    services: () => {
      throw { code: "EPERM" };
    }
  }), "services.list").invoke();
  assert.equal(objectThrown.message, "{\"code\":\"EPERM\"}");
});

test("system-tools: 同步采集器的结果透传并包成 { ok: true, data }", async () => {
  const report = { verdict: "ok", counts: { err: 0 }, notes: [] };
  const definitions = createSystemToolDefinitions({ snapshot: () => report });
  const result = await toolOf(definitions, "snapshot.summary").invoke();
  assert.deepEqual(result, { ok: true, data: report });
});

test("system-tools: 异步采集器同样被 await", async () => {
  const report = { verdict: "warning", devices: [{ device: "/dev/sda", verdict: "warning" }] };
  const definitions = createSystemToolDefinitions({ smart: async () => report });
  const result = await toolOf(definitions, "smart.summary").invoke();
  assert.deepEqual(result, { ok: true, data: report });
});

test("system-tools: 采集器返回 null 时如实返回 data: null，不伪造成健康", async () => {
  const definitions = createSystemToolDefinitions({ thermal: () => null });
  const result = await toolOf(definitions, "thermal.status").invoke();
  assert.deepEqual(result, { ok: true, data: null });
});

test("system-tools: events.recent 的 limit 上界、下界与类型都会被拒绝", async () => {
  const collector = spy({ verdict: "ok" });
  const definitions = createSystemToolDefinitions({ events: collector });
  const events = toolOf(definitions, "events.recent");

  assert.equal(events.inputSchema.properties.limit.maximum, MAX_EVENTS_LIMIT);
  assert.equal((await events.invoke({ limit: MAX_EVENTS_LIMIT })).ok, true);
  assert.equal(collector.calls.length, 1);

  const rejected = [MAX_EVENTS_LIMIT + 1, 0, -1, 1.5, "20", NaN, Infinity];
  for (const limit of rejected) {
    const result = await events.invoke({ limit });
    assert.equal(result.ok, false, `limit=${String(limit)} should be rejected`);
    assert.equal(result.reason, "invalid-arguments");
    assert.equal(result.id, "events.recent");
    assert.ok(result.errors.length > 0);
  }
  // 非法参数不得调起采集器。
  assert.equal(collector.calls.length, 1);
});

test("system-tools: events.recent 只转发调用方真正给出的过滤条件", async () => {
  const collector = spy({ verdict: "unknown" });
  const definitions = createSystemToolDefinitions({ events: collector });
  const events = toolOf(definitions, "events.recent");

  await events.invoke();
  assert.deepEqual(collector.calls.at(-1), [{ limit: DEFAULT_EVENTS_LIMIT }]);

  const since = "2026-10-01T00:00:00Z";
  await events.invoke({ limit: 5, since, level: "err" });
  assert.deepEqual(collector.calls.at(-1), [{ limit: 5, since, level: "err" }]);

  await events.invoke({ limit: 5, since: "x".repeat(MAX_EVENTS_SINCE_LENGTH) });
  assert.equal(collector.calls.at(-1)[0].since.length, MAX_EVENTS_SINCE_LENGTH);

  // 级别只能是 system-events 的 syslog 八级，别名（fatal/warn）不在枚举里。
  for (const level of ["fatal", "ERROR", ""]) {
    const result = await events.invoke({ level });
    assert.equal(result.ok, false, `level=${level} should be rejected`);
    assert.equal(result.reason, "invalid-arguments");
  }
  assert.equal((await events.invoke({ since: "x".repeat(MAX_EVENTS_SINCE_LENGTH + 1) })).ok, false);
  assert.equal(collector.calls.length, 3);
});

test("system-tools: capacity.forecast 的 horizonDays 默认 30，越界与字符串被拒绝", async () => {
  const collector = spy({ daysUntilFull: 42 });
  const definitions = createSystemToolDefinitions({ forecast: collector });
  const forecast = toolOf(definitions, "capacity.forecast");

  assert.equal(forecast.inputSchema.properties.horizonDays.maximum, MAX_FORECAST_HORIZON_DAYS);
  await forecast.invoke();
  assert.deepEqual(collector.calls.at(-1), [{ horizonDays: DEFAULT_FORECAST_HORIZON_DAYS }]);

  await forecast.invoke({ horizonDays: 90 });
  assert.deepEqual(collector.calls.at(-1), [{ horizonDays: 90 }]);

  for (const horizonDays of [0, MAX_FORECAST_HORIZON_DAYS + 1, 1.5, "30", null]) {
    const result = await forecast.invoke({ horizonDays });
    assert.equal(result.ok, false, `horizonDays=${String(horizonDays)} should be rejected`);
    assert.equal(result.reason, "invalid-arguments");
  }
  assert.equal(collector.calls.length, 2);
});

test("system-tools: 无参数工具拒绝白名单之外的参数", async () => {
  const collector = spy({ verdict: "ok" });
  const definitions = createSystemToolDefinitions({ capabilities: collector });
  const capabilities = toolOf(definitions, "capabilities.get");

  const result = await capabilities.invoke({ profile: "local-llm" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-arguments");
  assert.ok(result.errors.some(error => error.includes("unknown-argument: profile")));
  assert.equal(collector.calls.length, 0);

  // undefined 值的键按「没传」处理：JSON 里也表达不出来。
  assert.equal((await capabilities.invoke({ profile: undefined })).ok, true);
});

test("system-tools: 敏感键名（含嵌套与数组内）递归替换为 <redacted>，且不改写原始对象", async () => {
  const report = {
    verdict: "ok",
    password: "hunter2",
    userName: "someone",
    monkey: "banana",
    keyword: "search",
    nested: { apiKey: "sk-live-123", accessToken: "token", clientSecret: "secret", keep: "visible", level: 3 },
    passed: 3,
    devices: [{ secretName: "s", label: "/dev/sda" }, "plain", 7, null]
  };
  const definitions = createSystemToolDefinitions({ snapshot: () => report });
  const result = await toolOf(definitions, "snapshot.summary").invoke();

  assert.equal(result.ok, true);
  const data = result.data;
  assert.equal(data.password, REDACTED_PLACEHOLDER);
  assert.equal(data.userName, "someone");
  // 功能字段保持可见：能力体检的 passed 是判定结果，打码等于交出一串星号。
  assert.equal(data.passed, 3);
  // 规则故意做得很钝：passengerCount / monkey / keyword 都会被误伤，这是取舍不是缺陷。
  assert.equal(data.monkey, REDACTED_PLACEHOLDER);
  assert.equal(data.keyword, REDACTED_PLACEHOLDER);
  assert.equal(data.nested.apiKey, REDACTED_PLACEHOLDER);
  assert.equal(data.nested.accessToken, REDACTED_PLACEHOLDER);
  assert.equal(data.nested.clientSecret, REDACTED_PLACEHOLDER);
  assert.equal(data.nested.keep, "visible");
  assert.equal(data.nested.level, 3);
  assert.equal(data.devices[0].secretName, REDACTED_PLACEHOLDER);
  assert.equal(data.devices[0].label, "/dev/sda");
  assert.deepEqual(data.devices.slice(1), ["plain", 7, null]);
  assert.equal(data.verdict, "ok");

  // 清洗产出新对象：调用方手里的原始数据不被打码污染。
  assert.equal(report.password, "hunter2");
  assert.equal(report.nested.apiKey, "sk-live-123");
});

test("system-tools: 循环引用与超深结构不会让清洗阶段抛错", async () => {
  const cyclic = { name: "root" };
  cyclic.self = cyclic;
  const definitions = createSystemToolDefinitions({ services: () => cyclic });
  const result = await toolOf(definitions, "services.list").invoke();
  assert.equal(result.ok, true);
  assert.equal(result.data.name, "root");
  assert.equal(result.data.self, "[circular]");

  let deep = { leaf: "end" };
  for (let index = 0; index < 40; index += 1) deep = { child: deep };
  const deepResult = await toolOf(createSystemToolDefinitions({ services: () => deep }), "services.list").invoke();
  assert.equal(deepResult.ok, true);
  const serialized = JSON.stringify(deepResult.data);
  assert.ok(serialized.includes("[depth-limit]"));
});

test("system-tools: listSystemTools 只返回可序列化摘要，JSON.stringify 不打折", () => {
  const summary = listSystemTools();
  assert.equal(summary.length, 7);
  assert.deepEqual(summary.map(item => item.id), [...SYSTEM_TOOL_IDS]);
  for (const item of summary) {
    assert.deepEqual(Object.keys(item).sort(), ["id", "risk", "title"]);
    assert.equal(item.risk, "read-only");
    assert.equal(typeof item.title, "string");
  }
  const serialized = JSON.stringify(summary);
  assert.equal(typeof serialized, "string");
  assert.deepEqual(JSON.parse(serialized), summary);
});

test("system-tools: validateToolArguments 可直接复用，且与 invoke 结论一致", () => {
  assert.deepEqual(validateToolArguments("services.list", {}), { ok: true, errors: [] });
  assert.equal(validateToolArguments("services.list", []).ok, false);
  assert.equal(validateToolArguments("services.list", "x").ok, false);
  assert.equal(validateToolArguments("services.list", null).ok, true);
  const unknown = validateToolArguments("no.such.tool", {});
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors[0], /^unknown-tool: no\.such\.tool$/);
  // schema 有交集的两处校验必须给出同一个结论。
  const viaInvoke = validateToolArguments("events.recent", { limit: MAX_EVENTS_LIMIT + 1 });
  assert.equal(viaInvoke.ok, false);
  assert.ok(viaInvoke.errors.some(error => error.startsWith("above-maximum: limit")));
});

test("system-tools: 模块源码不引入任何 I/O 能力（安全红线锁死）", () => {
  const source = readFileSync(MODULE_PATH, "utf8");
  const specifiers = [...source.matchAll(/^\s*import\b[\s\S]*?from\s+["']([^"']+)["']/gm)].map(match => match[1]);
  assert.deepEqual(specifiers, ["./system-events.mjs"], "只允许导入零 I/O 的纯函数模块");
  for (const token of ["node:fs", "node:child_process", "node:net", "node:http", "node:https", "require(", "process.binding"]) {
    assert.ok(!specifiers.includes(token), `forbidden import: ${token}`);
  }
  assert.ok(!/^\s*import[^\n]*["']node:/m.test(source), "module must not import node builtins");
});

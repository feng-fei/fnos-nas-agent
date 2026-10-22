import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_DEDUPE_WINDOW_MS,
  DEFAULT_QUIET_HOURS,
  MAX_TRIGGERS,
  TRIGGER_KINDS,
  dedupeKey,
  evaluateTriggers,
  normalizeTriggerRule,
  notificationFor,
  quietHoursActive
} from "../apps/fnos-nas-agent/app/workflow-triggers.mjs";

const MODULE_URL = new URL("../apps/fnos-nas-agent/app/workflow-triggers.mjs", import.meta.url);

/** 本地时间 2026-01-15 的某个时刻；静默时段按本地时区解释，测试因此不依赖机器时区。 */
function at(hour, minute) {
  return new Date(2026, 0, 15, hour, minute, 0, 0);
}

function baseRule(overrides = {}) {
  return {
    id: "rule-1",
    kind: "service-down",
    workflowId: "wf-health",
    quietHours: "off",
    ...overrides
  };
}

function evaluate(rules, facts, { now = at(12, 0), state } = {}) {
  return evaluateTriggers(rules, facts, { now, state });
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const SERVICE_FACTS = { services: [{ name: "nginx", active: false }] };

test("常量：六类触发源冻结，边界值与文档一致", () => {
  assert.deepEqual([...TRIGGER_KINDS], [
    "service-down",
    "disk-space-low",
    "smart-warning",
    "thermal-high",
    "job-failed",
    "certificate-expiring"
  ]);
  assert.ok(Object.isFrozen(TRIGGER_KINDS));
  assert.equal(MAX_TRIGGERS, 200);
  assert.equal(DEFAULT_DEDUPE_WINDOW_MS, 15 * 60 * 1000);
  assert.deepEqual({ ...DEFAULT_QUIET_HOURS }, { start: "23:00", end: "07:00" });
  assert.ok(Object.isFrozen(DEFAULT_QUIET_HOURS));
  assert.throws(() => { TRIGGER_KINDS.push("other"); }, TypeError);
});

test("normalizeTriggerRule：合法规则补齐默认条件、冷却与静默时段", () => {
  const result = normalizeTriggerRule(baseRule());
  assert.equal(result.ok, true);
  assert.deepEqual(result.rule, {
    id: "rule-1",
    kind: "service-down",
    workflowId: "wf-health",
    condition: { threshold: null, unit: null, target: null },
    cooldownMs: DEFAULT_DEDUPE_WINDOW_MS,
    quietHours: "off",
    enabled: true
  });
  assert.ok(Object.isFrozen(result.rule));
  assert.ok(Object.isFrozen(result.rule.condition));

  const disk = normalizeTriggerRule(baseRule({ kind: "disk-space-low" }));
  assert.deepEqual(disk.rule.condition, { threshold: 90, unit: "%", target: null });
  const thermal = normalizeTriggerRule(baseRule({ kind: "thermal-high" }));
  assert.deepEqual(thermal.rule.condition, { threshold: 65, unit: "celsius", target: null });
  const cert = normalizeTriggerRule(baseRule({ kind: "certificate-expiring" }));
  assert.deepEqual(cert.rule.condition, { threshold: 30, unit: "days", target: null });

  const bounds = normalizeTriggerRule(baseRule({ cooldownMs: 0, quietHours: undefined }));
  assert.equal(bounds.rule.cooldownMs, 0);
  assert.deepEqual(bounds.rule.quietHours, DEFAULT_QUIET_HOURS);
  assert.equal(normalizeTriggerRule(baseRule({ cooldownMs: 24 * 60 * 60 * 1000 })).ok, true);
});

test("normalizeTriggerRule：非法规格给出稳定 reason（八类拒绝）", () => {
  const cases = [
    [null, "invalid-rule"],
    [[], "invalid-rule"],
    ["rule-1", "invalid-rule"],
    [{ ...baseRule(), id: "Bad_ID" }, "invalid-id"],
    [{ ...baseRule(), id: "a".repeat(65) }, "invalid-id"],
    [{ ...baseRule(), kind: "service-up" }, "unknown-kind"],
    [{ ...baseRule(), kind: undefined }, "unknown-kind"],
    [{ ...baseRule(), workflowId: "   " }, "missing-workflow-id"],
    [{ ...baseRule(), workflowId: "w".repeat(129) }, "invalid-workflow-id"],
    [{ ...baseRule(), cooldownMs: -1 }, "invalid-cooldown"],
    [{ ...baseRule(), cooldownMs: 24 * 60 * 60 * 1000 + 1 }, "invalid-cooldown"],
    [{ ...baseRule(), cooldownMs: 1.5 }, "invalid-cooldown"],
    [{ ...baseRule(), quietHours: { start: "25:00", end: "07:00" } }, "invalid-quiet-hours"],
    [{ ...baseRule(), quietHours: "on" }, "invalid-quiet-hours"],
    [{ ...baseRule(), enabled: "false" }, "invalid-enabled"],
    [{ ...baseRule(), condition: { threshold: "90" } }, "invalid-condition"],
    [{ ...baseRule(), kind: "disk-space-low", condition: { unit: "days" } }, "invalid-condition"],
    [{ ...baseRule(), kind: "disk-space-low", condition: { threshold: 101 } }, "invalid-condition"],
    [{ ...baseRule(), condition: { typo: 1 } }, "invalid-condition"]
  ];
  for (const [input, reason] of cases) {
    const result = normalizeTriggerRule(input);
    assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason }, `expected ${reason}`);
  }
});

test("evaluateTriggers：六类 kind 各触发一次", () => {
  const cases = [
    ["service-down", "nginx", SERVICE_FACTS, "停止"],
    ["disk-space-low", "/vol1", { disks: [{ mount: "/vol1", usedPercent: 95 }] }, "使用率"],
    ["smart-warning", "/dev/sda", { smart: [{ device: "/dev/sda", status: "warning" }] }, "SMART"],
    ["thermal-high", "cpu", { thermal: [{ zone: "cpu", celsius: 78 }] }, "温度"],
    ["job-failed", "backup", { jobs: [{ id: "backup", ok: false }] }, "失败"],
    ["certificate-expiring", "example.com", { certificates: [{ host: "example.com", daysRemaining: 7 }] }, "证书"]
  ];

  for (const [kind, subject, facts, detailFragment] of cases) {
    const rules = [baseRule({ kind })];
    const result = evaluate(rules, facts);
    assert.equal(result.fire.length, 1, `kind ${kind} should fire once`);
    assert.equal(result.suppressed.length, 0);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.notes, []);
    const [fired] = result.fire;
    assert.equal(fired.ruleId, "rule-1");
    assert.equal(fired.workflowId, "wf-health");
    assert.equal(fired.kind, kind);
    assert.equal(fired.subject, subject);
    assert.equal(fired.dedupeKey, `rule-1:${subject}`);
    assert.match(fired.detail, new RegExp(detailFragment, "u"));
  }
});

test("evaluateTriggers：阈值可覆盖，等于阈值时触发", () => {
  const thermal = baseRule({ kind: "thermal-high", condition: { threshold: 70 } });
  assert.equal(evaluate([thermal], { thermal: [{ zone: "cpu", celsius: 70 }] }).fire.length, 1);
  assert.equal(evaluate([thermal], { thermal: [{ zone: "cpu", celsius: 69.9 }] }).fire.length, 0);

  const disk = baseRule({ kind: "disk-space-low", condition: { threshold: 80 } });
  assert.equal(evaluate([disk], { disks: [{ mount: "/vol1", usedPercent: 80 }] }).fire.length, 1);
  assert.equal(evaluate([disk], { disks: [{ mount: "/vol1", usedPercent: 79.9 }] }).fire.length, 0);

  const cert = baseRule({ kind: "certificate-expiring", condition: { threshold: 10 } });
  assert.equal(evaluate([cert], { certificates: [{ host: "a.example", daysRemaining: 10 }] }).fire.length, 1);
  assert.equal(evaluate([cert], { certificates: [{ host: "a.example", daysRemaining: 11 }] }).fire.length, 0);
  // 已过期（负天数）同样落在「即将过期」的判定里。
  assert.equal(evaluate([cert], { certificates: [{ host: "a.example", daysRemaining: -3 }] }).fire.length, 1);
});

test("evaluateTriggers：缺事实一律不触发（无证据）", () => {
  const rules = TRIGGER_KINDS.map((kind, index) => baseRule({ id: `rule-${index}`, kind }));

  const empty = evaluate(rules, {});
  assert.equal(empty.fire.length, 0);
  assert.deepEqual(empty.suppressed, rules.map((rule) => ({ ruleId: rule.id, reason: "no-facts" })));

  // 字段存在但为空数组，同样是没有证据。
  const blank = evaluate(rules, { services: [], disks: [], smart: [], thermal: [], jobs: [], certificates: [] });
  assert.equal(blank.fire.length, 0);
  assert.equal(blank.suppressed.every((entry) => entry.reason === "no-facts"), true);

  // 只给了服务事实：磁盘/温度/证书规则仍是 no-facts，而不是「健康」。
  const partial = evaluate(rules, SERVICE_FACTS);
  assert.equal(partial.fire.length, 1);
  assert.equal(partial.fire[0].kind, "service-down");
  assert.deepEqual(
    partial.suppressed.map((entry) => entry.reason),
    ["no-facts", "no-facts", "no-facts", "no-facts", "no-facts"]
  );
});

test("evaluateTriggers：状态未知或字段类型不对时不触发", () => {
  assert.equal(evaluate([baseRule()], { services: [{ name: "nginx" }] }).fire.length, 0);
  assert.equal(evaluate([baseRule()], { services: [{ name: "nginx", active: "false" }] }).fire.length, 0);
  assert.equal(
    evaluate([baseRule({ kind: "disk-space-low" })], { disks: [{ mount: "/vol1", usedPercent: "95" }] }).fire.length,
    0
  );
  assert.equal(
    evaluate([baseRule({ kind: "disk-space-low" })], { disks: [{ mount: "", usedPercent: 95 }] }).fire.length,
    0
  );
  assert.equal(
    evaluate([baseRule({ kind: "smart-warning" })], { smart: [{ device: "/dev/sda", status: "unknown" }] }).fire.length,
    0
  );
  assert.equal(
    evaluate([baseRule({ kind: "thermal-high" })], { thermal: [{ zone: "cpu", celsius: null }] }).fire.length,
    0
  );
  assert.equal(evaluate([baseRule({ kind: "job-failed" })], { jobs: [{ id: "backup" }] }).fire.length, 0);
  assert.equal(
    evaluate([baseRule({ kind: "certificate-expiring" })], { certificates: [{ host: "a.example", daysRemaining: "5" }] })
      .fire.length,
    0
  );
  // 数组里的畸形条目被跳过，其余合法条目照常判定。
  const mixed = evaluate([baseRule()], { services: [null, 42, { name: "nginx", active: false }] });
  assert.equal(mixed.fire.length, 1);
  assert.equal(mixed.fire[0].subject, "nginx");
});

test("evaluateTriggers：facts 不是对象时不抛错，按无证据处理", () => {
  for (const facts of [null, undefined, 42, "facts", []]) {
    const result = evaluate([baseRule()], facts);
    assert.equal(result.fire.length, 0);
    assert.deepEqual(result.suppressed, [{ ruleId: "rule-1", reason: "no-facts" }]);
  }
});

test("evaluateTriggers：冷却窗口内抑制同一对象，窗口结束后恢复", () => {
  const rule = baseRule({ cooldownMs: 60_000 });
  const start = at(12, 0);

  const first = evaluateTriggers([rule], SERVICE_FACTS, { now: start });
  assert.equal(first.fire.length, 1);
  assert.equal(first.state.lastFiredAt["rule-1:nginx"], start.getTime());

  const tooSoon = evaluateTriggers([rule], SERVICE_FACTS, {
    now: new Date(start.getTime() + 59_999),
    state: first.state
  });
  assert.equal(tooSoon.fire.length, 0);
  assert.deepEqual(tooSoon.suppressed, [{
    ruleId: "rule-1",
    reason: "cooldown",
    subject: "nginx",
    dedupeKey: "rule-1:nginx"
  }]);
  // 被冷却拦下的判定不得刷新时间戳。
  assert.equal(tooSoon.state.lastFiredAt["rule-1:nginx"], start.getTime());

  const exactly = evaluateTriggers([rule], SERVICE_FACTS, {
    now: new Date(start.getTime() + 60_000),
    state: tooSoon.state
  });
  assert.equal(exactly.fire.length, 1);
  assert.equal(exactly.state.lastFiredAt["rule-1:nginx"], start.getTime() + 60_000);
});

test("evaluateTriggers：cooldownMs 为 0 时不抑制", () => {
  const rule = baseRule({ cooldownMs: 0 });
  const start = at(12, 0);
  const first = evaluateTriggers([rule], SERVICE_FACTS, { now: start });
  const second = evaluateTriggers([rule], SERVICE_FACTS, { now: start, state: first.state });
  assert.equal(first.fire.length, 1);
  assert.equal(second.fire.length, 1);
  assert.deepEqual(second.suppressed, []);
});

test("evaluateTriggers：默认静默时段抑制（跨午夜两侧）", () => {
  const rule = baseRule({ quietHours: undefined }); // 默认 23:00–07:00
  const beforeMidnight = evaluate([rule], SERVICE_FACTS, { now: at(23, 30) });
  assert.equal(beforeMidnight.fire.length, 0);
  assert.deepEqual(beforeMidnight.suppressed, [{ ruleId: "rule-1", reason: "quiet-hours" }]);

  const afterMidnight = evaluate([rule], SERVICE_FACTS, { now: at(3, 0) });
  assert.equal(afterMidnight.fire.length, 0);
  assert.deepEqual(afterMidnight.suppressed, [{ ruleId: "rule-1", reason: "quiet-hours" }]);

  const daytime = evaluate([rule], SERVICE_FACTS, { now: at(12, 0) });
  assert.equal(daytime.fire.length, 1);
});

test("quietHoursActive：跨午夜边界、关闭与等长窗口", () => {
  const window = { start: "23:00", end: "07:00" };
  assert.equal(quietHoursActive(window, at(23, 0)), true);
  assert.equal(quietHoursActive(window, at(23, 59)), true);
  assert.equal(quietHoursActive(window, at(0, 0)), true);
  assert.equal(quietHoursActive(window, at(6, 59)), true);
  assert.equal(quietHoursActive(window, at(7, 0)), false);
  assert.equal(quietHoursActive(window, at(22, 59)), false);

  assert.equal(quietHoursActive({ start: "08:00", end: "18:00" }, at(8, 0)), true);
  assert.equal(quietHoursActive({ start: "08:00", end: "18:00" }, at(18, 0)), false);
  assert.equal(quietHoursActive("off", at(23, 30)), false);
  assert.equal(quietHoursActive({ start: "23:00", end: "23:00" }, at(23, 30)), false);
  assert.equal(quietHoursActive({ start: "bad", end: "07:00" }, at(23, 30)), false);
  assert.equal(quietHoursActive(window, new Date(Number.NaN)), false);
});

test("evaluateTriggers：工作流已在运行时抑制（数组与 Set 两种形态）", () => {
  for (const running of [["wf-health"], new Set(["wf-health"]), { "wf-health": true }]) {
    const result = evaluateTriggers([baseRule()], SERVICE_FACTS, { now: at(12, 0), state: { running } });
    assert.equal(result.fire.length, 0);
    assert.deepEqual(result.suppressed, [{ ruleId: "rule-1", reason: "already-running" }]);
  }
  const other = evaluateTriggers([baseRule()], SERVICE_FACTS, {
    now: at(12, 0),
    state: { running: ["wf-other"] }
  });
  assert.equal(other.fire.length, 1);
});

test("evaluateTriggers：disabled 规则只记录 disabled", () => {
  const rule = baseRule({ enabled: false });
  const result = evaluate(rule ? [rule] : [], {});
  assert.equal(result.fire.length, 0);
  assert.deepEqual(result.suppressed, [{ ruleId: "rule-1", reason: "disabled" }]);
});

test("evaluateTriggers：now 缺失时不触发，也不回退到当前时间", () => {
  for (const now of [undefined, null, new Date(Number.NaN), "not-a-date", {}]) {
    const result = evaluateTriggers([baseRule()], SERVICE_FACTS, { now });
    assert.equal(result.fire.length, 0);
    assert.deepEqual(result.suppressed, []);
    assert.ok(result.notes.includes("now-missing"));
  }

  // 显式传入 0 是「可信时钟」，按 epoch 0 计算，不算 missing。
  const epoch = evaluateTriggers([baseRule()], SERVICE_FACTS, { now: 0 });
  assert.equal(epoch.fire.length, 1);
  assert.equal(epoch.state.lastFiredAt["rule-1:nginx"], 0);
  assert.ok(!epoch.notes.includes("now-missing"));
});

test("evaluateTriggers：超过 MAX_TRIGGERS 截断并标记 truncated", () => {
  const rules = Array.from({ length: MAX_TRIGGERS + 5 }, (_, index) => baseRule({ id: `rule-${index}` }));
  const result = evaluate(rules, SERVICE_FACTS);
  assert.equal(result.truncated, true);
  assert.ok(result.notes.includes("rules-truncated"));
  assert.equal(result.fire.length, MAX_TRIGGERS);
  assert.equal(result.fire[0].ruleId, "rule-0");
  assert.equal(result.fire[result.fire.length - 1].ruleId, `rule-${MAX_TRIGGERS - 1}`);

  const exact = evaluate(rules.slice(0, MAX_TRIGGERS), SERVICE_FACTS);
  assert.equal(exact.truncated, false);
  assert.equal(exact.fire.length, MAX_TRIGGERS);
});

test("evaluateTriggers：同一规则命中多个对象时各生成一条 fire", () => {
  const facts = { services: [
    { name: "nginx", active: false },
    { name: "redis", active: false },
    { name: "sshd", active: true }
  ] };
  const result = evaluate([baseRule()], facts);
  assert.equal(result.fire.length, 2);
  assert.deepEqual(result.fire.map((entry) => entry.subject), ["nginx", "redis"]);
  assert.deepEqual(result.fire.map((entry) => entry.dedupeKey), ["rule-1:nginx", "rule-1:redis"]);
  assert.notEqual(result.fire[0].dedupeKey, result.fire[1].dedupeKey);
  assert.equal(new Set(result.fire.map((entry) => entry.dedupeKey)).size, 2);
});

test("evaluateTriggers：condition.target 只匹配指定对象", () => {
  const rule = baseRule({
    kind: "disk-space-low",
    condition: { target: "/vol1", threshold: 90 }
  });
  const result = evaluate([rule], {
    disks: [
      { mount: "/vol1", usedPercent: 95 },
      { mount: "/vol2", usedPercent: 99 }
    ]
  });
  assert.equal(result.fire.length, 1);
  assert.equal(result.fire[0].subject, "/vol1");

  const missing = evaluate([rule], { disks: [{ mount: "/vol2", usedPercent: 99 }] });
  assert.equal(missing.fire.length, 0);
});

test("notificationFor：六类 kind 的 level 映射与标题", () => {
  const expected = {
    "service-down": "warning",
    "disk-space-low": "warning",
    "smart-warning": "critical",
    "thermal-high": "critical",
    "job-failed": "warning",
    "certificate-expiring": "info"
  };
  for (const [kind, level] of Object.entries(expected)) {
    const notification = notificationFor({ kind, subject: "target-1" });
    assert.equal(notification.level, level, `kind ${kind}`);
    assert.equal(typeof notification.title, "string");
    assert.ok(notification.title.length > 0);
    assert.equal(typeof notification.body, "string");
    assert.ok(notification.body.includes("target-1"));
  }
  const unknown = notificationFor({ kind: "unknown-kind", subject: "x" });
  assert.equal(unknown.level, "info");
  assert.equal(typeof unknown.body, "string");
  assert.equal(notificationFor(null).level, "info");
});

test("notificationFor：正文不携带路径、原始日志或换行", () => {
  const samples = [
    { kind: "service-down", subject: "/etc/nginx/sites-enabled/default" },
    { kind: "smart-warning", subject: "/dev/sda" },
    { kind: "disk-space-low", subject: "/vol1" },
    { kind: "job-failed", subject: "backup\nError: permission denied" },
    { kind: "thermal-high", subject: "C:\\Users\\Administrator\\zone" }
  ];
  for (const fired of samples) {
    const { body } = notificationFor(fired);
    assert.doesNotMatch(body, /[\\/]/u, `body must not contain a path: ${body}`);
    assert.doesNotMatch(body, /[\r\n\u0000-\u001f]/u);
  }
  // 原始日志只可能藏在 detail 里：通知正文不引用 detail，也不回显日志文本。
  const withLog = notificationFor({
    kind: "job-failed",
    subject: "backup",
    detail: "Traceback: /var/log/backup.log line 42: permission denied"
  });
  assert.doesNotMatch(withLog.body, /Traceback|backup\.log|line 42|permission denied/u);
  assert.equal(notificationFor({ kind: "smart-warning", subject: "/dev/sda" }).body.includes("sda"), true);
  const rootPath = notificationFor({ kind: "disk-space-low", subject: "/" });
  assert.equal(rootPath.body.includes("未知对象"), true);
  assert.doesNotMatch(rootPath.body, /[\\/]/u);
});

test("dedupeKey：稳定、可区分，并接受事实对象", () => {
  const rule = baseRule();
  assert.equal(dedupeKey(rule, "nginx"), "rule-1:nginx");
  assert.equal(dedupeKey(rule, { subject: "nginx" }), "rule-1:nginx");
  assert.equal(dedupeKey(rule, "nginx"), dedupeKey(rule, "nginx"));
  assert.notEqual(dedupeKey(rule, "nginx"), dedupeKey(rule, "redis"));
  assert.notEqual(dedupeKey(rule, "nginx"), dedupeKey(baseRule({ id: "rule-2" }), "nginx"));
  assert.equal(dedupeKey({ id: "Bad_ID" }, "nginx"), "unknown:nginx");
  assert.equal(dedupeKey(rule, ""), "rule-1:unknown");
  assert.equal(dedupeKey(rule, "  nginx  "), "rule-1:nginx");
});

test("不修改入参：规则、事实与状态在判定前后深度相等", () => {
  const rules = deepFreeze([{
    id: "rule-1",
    kind: "service-down",
    workflowId: "wf-health",
    condition: { threshold: null, unit: null, target: null },
    cooldownMs: DEFAULT_DEDUPE_WINDOW_MS,
    quietHours: "off",
    enabled: true
  }]);
  const facts = deepFreeze({
    services: [{ name: "nginx", active: false }],
    disks: [{ mount: "/vol1", usedPercent: 95 }]
  });
  const state = deepFreeze({
    lastFiredAt: { "old-rule:web": 1 },
    running: ["wf-other"]
  });

  const before = JSON.stringify({ rules, facts, state });
  const result = evaluateTriggers(rules, facts, { now: at(12, 0), state });
  assert.equal(JSON.stringify({ rules, facts, state }), before);

  assert.notEqual(result.state, state);
  assert.notEqual(result.state.lastFiredAt, state.lastFiredAt);
  assert.equal(result.fire.length, 1);
  assert.equal(result.fire[0].subject, "nginx");
  assert.equal(Object.isFrozen(state), true);
});

test("state：规则被删除后，其冷却键在下次判定时被裁剪", () => {
  const start = at(12, 0);
  const first = evaluateTriggers([baseRule()], SERVICE_FACTS, { now: start });
  assert.deepEqual(Object.keys(first.state.lastFiredAt), ["rule-1:nginx"]);

  const otherRule = baseRule({ id: "rule-2" });
  const second = evaluateTriggers([otherRule], SERVICE_FACTS, { now: start, state: first.state });
  assert.equal(second.fire.length, 1);
  assert.deepEqual(Object.keys(second.state.lastFiredAt), ["rule-2:nginx"]);
});

test("源码纯度：零 import、无系统时钟、无定时器与 I/O", () => {
  const source = readFileSync(MODULE_URL, "utf8");
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");
  assert.doesNotMatch(code, /^\s*import\s/mu);
  assert.doesNotMatch(code, /\brequire\s*\(/u);
  assert.doesNotMatch(code, /\bDate\.now\s*\(/u);
  assert.doesNotMatch(code, /new\s+Date\s*\(\s*\)/u);
  assert.doesNotMatch(code, /\b(?:setTimeout|setInterval|setImmediate|queueMicrotask)\b/u);
  assert.doesNotMatch(code, /\b(?:fetch|readFile|writeFile|readdir)\s*\(/u);
  assert.doesNotMatch(code, /node:(?:fs|http|https|net|child_process|crypto)/u);
  assert.doesNotMatch(code, /\bprocess\s*\./u);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_TTL_MS,
  IDEMPOTENCY_DECISIONS,
  MAX_KEY_LENGTH,
  MAX_RECORDS,
  createIdempotencyStore,
  fingerprintRequest,
  normalizeIdempotencyKey
} from "../apps/fnos-nas-agent/app/idempotency.mjs";

const MODULE_URL = new URL("../apps/fnos-nas-agent/app/idempotency.mjs", import.meta.url);

function createClock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms) { value += ms; },
    read: () => value
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function request(key, params = { file: "a.txt" }, action = "file.rename") {
  return { key, action, params };
}

test("常量：决策枚举冻结，边界值与文档一致", () => {
  assert.deepEqual({ ...IDEMPOTENCY_DECISIONS }, {
    EXECUTE: "execute",
    REPLAY: "replay",
    IN_PROGRESS: "in-progress",
    CONFLICT: "conflict",
    REJECT: "reject"
  });
  assert.ok(Object.isFrozen(IDEMPOTENCY_DECISIONS));
  assert.equal(MAX_KEY_LENGTH, 128);
  assert.equal(MAX_RECORDS, 500);
  assert.equal(DEFAULT_TTL_MS, 24 * 60 * 60 * 1000);
  assert.throws(() => { IDEMPOTENCY_DECISIONS.EXECUTE = "other"; }, TypeError);
});

test("store：返回冻结对象，六个方法齐全且初始为空", () => {
  const store = createIdempotencyStore();
  assert.ok(Object.isFrozen(store));
  assert.deepEqual(Object.keys(store).sort(), ["begin", "complete", "fail", "lookup", "prune", "size"]);
  assert.equal(store.size(), 0);
  assert.equal(store.lookup("missing"), null);
});

test("normalizeIdempotencyKey：trim 后接受白名单字符与 128 字符上限", () => {
  assert.equal(normalizeIdempotencyKey("  order:42.v1_a-b  "), "order:42.v1_a-b");
  assert.equal(normalizeIdempotencyKey("A".repeat(128)), "A".repeat(128));
  assert.equal(normalizeIdempotencyKey("x"), "x");
});

test("normalizeIdempotencyKey：空、超长、斜杠、空格与中文一律 null", () => {
  const invalid = ["", "   ", "\t\n", "A".repeat(129), "a/b", "a b", "a\tb", "订单-1", "a\nb", null, undefined, 42, {}, []];
  for (const value of invalid) assert.equal(normalizeIdempotencyKey(value), null, `expected null for ${String(value)}`);
});

test("幂等主路径：首次 execute → complete → 同指纹 replay", () => {
  const clock = createClock();
  const store = createIdempotencyStore({ now: clock.now });
  const first = store.begin(request("task-1", { from: "a", to: "b" }));
  assert.equal(first.decision, IDEMPOTENCY_DECISIONS.EXECUTE);
  assert.match(first.token, /^t\d+$/u);

  const running = store.lookup("task-1");
  assert.equal(running.status, "in-progress");
  assert.equal(running.result, undefined);
  assert.equal(running.completedAt, null);
  assert.equal(running.expiresAt, null);
  assert.deepEqual(running.notes, []);

  assert.deepEqual(store.complete({ key: "task-1", result: { renamed: true } }), { ok: true });
  const done = store.lookup("task-1");
  assert.equal(done.status, "completed");
  assert.equal(done.completedAt, clock.read());
  assert.equal(done.expiresAt, clock.read() + DEFAULT_TTL_MS);

  const replay = store.begin(request("task-1", { from: "a", to: "b" }));
  assert.equal(replay.decision, IDEMPOTENCY_DECISIONS.REPLAY);
  assert.deepEqual(replay.result, { renamed: true });
  assert.equal(replay.token, undefined);
});

test("进行中：第二次 begin 同指纹返回 in-progress，不重复执行", () => {
  const store = createIdempotencyStore({ now: createClock().now });
  store.begin(request("task-2"));
  const second = store.begin(request("task-2"));
  assert.deepEqual(second, { decision: "in-progress" });
  assert.equal(second.token, undefined);
  assert.equal(store.size(), 1);
});

test("冲突：同 key 不同 action 返回 conflict 且不覆盖原记录", () => {
  const store = createIdempotencyStore({ now: createClock().now });
  assert.equal(store.begin(request("task-3", { a: 1 }, "file.rename")).decision, "execute");
  assert.deepEqual(store.begin(request("task-3", { a: 1 }, "file.delete")), { decision: "conflict" });
  const view = store.lookup("task-3");
  assert.equal(view.status, "in-progress");
  assert.equal(view.fingerprint, fingerprintRequest("file.rename", { a: 1 }));
});

test("冲突：同 key 不同 params 不覆盖，原始 params 仍 replay 首次结果", () => {
  const store = createIdempotencyStore({ now: createClock().now });
  store.begin(request("task-4", { a: 1 }));
  assert.deepEqual(store.begin(request("task-4", { a: 2 })), { decision: "conflict" });
  store.complete({ key: "task-4", result: "first" });
  assert.deepEqual(store.begin(request("task-4", { a: 2 })), { decision: "conflict" });
  assert.deepEqual(store.begin(request("task-4", { a: 1 })), { decision: "replay", result: "first" });
});

test("非法 key：begin 返回 reject/invalid-key，且不产生记录", () => {
  const store = createIdempotencyStore({ now: createClock().now });
  for (const key of ["", "  ", "a/b", "a b", "订单-1", "A".repeat(129), undefined]) {
    assert.deepEqual(store.begin({ key, action: "file.rename", params: {} }), { decision: "reject", reason: "invalid-key" });
  }
  assert.equal(store.size(), 0);
  assert.equal(store.lookup("a/b"), null);
});

test("非法 action：返回 reject/invalid-action", () => {
  const store = createIdempotencyStore({ now: createClock().now });
  for (const action of ["", "   ", undefined, 42, "a".repeat(129)]) {
    assert.deepEqual(store.begin({ key: "k", action, params: {} }), { decision: "reject", reason: "invalid-action" });
  }
  assert.equal(store.size(), 0);
});

test("非法 params：函数、undefined、Symbol、BigInt 均 reject/invalid-params", () => {
  const store = createIdempotencyStore({ now: createClock().now });
  const cases = [
    () => {},
    undefined,
    { nested: undefined },
    { symbol: Symbol("x") },
    { big: 1n },
    [1, undefined, 3]
  ];
  for (const [index, params] of cases.entries()) {
    assert.deepEqual(store.begin({ key: `params-${index}`, action: "file.rename", params }), { decision: "reject", reason: "invalid-params" });
  }
  assert.equal(store.size(), 0);
});

test("非法 params：循环引用与超过深度上限的嵌套 → invalid-params", () => {
  const store = createIdempotencyStore({ now: createClock().now });
  const circular = { name: "loop" };
  circular.self = circular;
  assert.deepEqual(store.begin({ key: "circular", action: "x", params: circular }), { decision: "reject", reason: "invalid-params" });

  let deep = {};
  for (let index = 0; index < 40; index += 1) deep = { deep };
  assert.equal(fingerprintRequest("x", deep), null);
});

test("非法 params：Date、Map、NaN、类实例都按不猜原则拒绝", () => {
  class Payload { constructor() { this.a = 1; } }
  const invalid = [new Date(0), new Map([["a", 1]]), { n: Number.NaN }, { n: Infinity }, new Payload(), [new Set([1])]];
  for (const params of invalid) assert.equal(fingerprintRequest("x", params), null);
  assert.equal(fingerprintRequest("x", Object.create(null)), "1:x:{}");
  assert.equal(typeof fingerprintRequest("x", { ok: [1, "two", null, true] }), "string");
});

test("稳定序列化：键排序递归，参数顺序不同指纹相同", () => {
  const left = { b: 2, a: { d: [1, { z: 1, y: 2 }], c: 3 } };
  const right = { a: { c: 3, d: [1, { y: 2, z: 1 }] }, b: 2 };
  assert.equal(fingerprintRequest("file.rename", left), fingerprintRequest("file.rename", right));

  const store = createIdempotencyStore({ now: createClock().now });
  store.begin({ key: "sorted", action: "file.rename", params: left });
  assert.deepEqual(store.begin({ key: "sorted", action: "file.rename", params: right }), { decision: "in-progress" });
});

test("fingerprintRequest：action/params 不同即不同，非法输入返回 null", () => {
  assert.equal(typeof fingerprintRequest("x", null), "string");
  assert.notEqual(fingerprintRequest("x", { a: 1 }), fingerprintRequest("y", { a: 1 }));
  assert.notEqual(fingerprintRequest("x", { a: 1 }), fingerprintRequest("x", { a: 1, b: 2 }));
  assert.notEqual(fingerprintRequest("x", { a: 1 }), fingerprintRequest("x", { a: "1" }));
  assert.equal(fingerprintRequest("", { a: 1 }), null);
  assert.equal(fingerprintRequest("x", undefined), null);
});

test("TTL：未到期 replay，到期瞬间视为不存在并可重新 execute", () => {
  const clock = createClock(1_000);
  const store = createIdempotencyStore({ now: clock.now, ttlMs: 5_000 });
  const first = store.begin(request("ttl-1"));
  store.complete({ key: "ttl-1", result: "done" });

  clock.advance(4_999);
  assert.deepEqual(store.begin(request("ttl-1")), { decision: "replay", result: "done" });

  clock.advance(1);
  assert.equal(store.lookup("ttl-1"), null);
  const again = store.begin(request("ttl-1"));
  assert.equal(again.decision, "execute");
  assert.notEqual(again.token, first.token);
});

test("TTL 以完成时刻起算，而不是 begin 时刻", () => {
  const clock = createClock(0);
  const store = createIdempotencyStore({ now: clock.now, ttlMs: 1_000 });
  store.begin(request("ttl-2"));
  clock.advance(60_000);
  store.complete({ key: "ttl-2", result: "late" });
  clock.advance(999);
  assert.equal(store.lookup("ttl-2").status, "completed");
  clock.advance(1);
  assert.equal(store.lookup("ttl-2"), null);
});

test("prune/size：只清理过期已完成记录，in-progress 不按 TTL 过期", () => {
  const clock = createClock(0);
  const store = createIdempotencyStore({ now: clock.now, ttlMs: 1_000 });
  store.begin(request("a"));
  store.complete({ key: "a", result: 1 });
  store.begin(request("b"));
  assert.equal(store.size(), 2);

  clock.advance(1_000);
  assert.equal(store.prune(), 1);
  assert.equal(store.size(), 1);
  assert.equal(store.lookup("b").status, "in-progress");

  store.complete({ key: "b", result: 2 });
  clock.advance(1_000);
  assert.equal(store.size(), 0);
  assert.equal(store.prune(), 0);
});

test("maxRecords：按最后访问时间淘汰最久未用的已完成记录", () => {
  const clock = createClock(100);
  const store = createIdempotencyStore({ now: clock.now, maxRecords: 3, ttlMs: 60_000 });
  for (const key of ["a", "b", "c"]) {
    store.begin(request(key));
    store.complete({ key, result: key });
    clock.advance(10);
  }
  const touched = store.lookup("a");
  assert.equal(touched.status, "completed");
  assert.equal(touched.result, "a");

  clock.advance(10);
  const inserted = store.begin(request("d"));
  assert.equal(inserted.decision, "execute");

  assert.equal(store.lookup("b"), null);
  assert.equal(store.lookup("a").result, "a");
  assert.equal(store.lookup("c").result, "c");
  assert.equal(store.lookup("d").status, "in-progress");
  assert.equal(store.size(), 3);
});

test("maxRecords：in-progress 记录不会被淘汰，淘汰只发生在已完成记录上", () => {
  const clock = createClock(0);
  const store = createIdempotencyStore({ now: clock.now, maxRecords: 2, ttlMs: 60_000 });
  store.begin(request("running"));
  store.begin(request("done"));
  store.complete({ key: "done", result: "ok" });

  clock.advance(10);
  assert.equal(store.begin(request("new")).decision, "execute");
  assert.equal(store.lookup("running").status, "in-progress");
  assert.equal(store.lookup("done"), null);
  assert.equal(store.size(), 2);
});

test("maxRecords：全部是 in-progress 时不淘汰，返回 reject/capacity", () => {
  const store = createIdempotencyStore({ now: createClock().now, maxRecords: 2 });
  store.begin(request("a"));
  store.begin(request("b"));
  assert.deepEqual(store.begin(request("c")), { decision: "reject", reason: "capacity" });
  assert.equal(store.size(), 2);
  assert.equal(store.lookup("a").status, "in-progress");
  assert.equal(store.lookup("b").status, "in-progress");
});

test("complete/fail：未知 key 是安全空操作，返回 unknown-key", () => {
  const store = createIdempotencyStore({ now: createClock().now });
  assert.deepEqual(store.complete({ key: "ghost", result: 1 }), { ok: false, reason: "unknown-key" });
  assert.deepEqual(store.fail({ key: "ghost" }), { ok: false, reason: "unknown-key" });
  assert.deepEqual(store.complete({ key: "bad/key", result: 1 }), { ok: false, reason: "invalid-key" });
  assert.deepEqual(store.fail({}), { ok: false, reason: "invalid-key" });
  assert.equal(store.size(), 0);
});

test("fail：进行中失败后可重新 execute，已完成记录不允许回退", () => {
  const clock = createClock();
  const store = createIdempotencyStore({ now: clock.now });
  const first = store.begin(request("retry"));
  assert.deepEqual(store.fail({ key: "retry" }), { ok: true });
  assert.equal(store.lookup("retry"), null);

  const second = store.begin(request("retry"));
  assert.equal(second.decision, "execute");
  assert.notEqual(second.token, first.token);

  store.complete({ key: "retry", result: "kept" });
  assert.deepEqual(store.fail({ key: "retry" }), { ok: false, reason: "already-completed" });
  assert.deepEqual(store.begin(request("retry")), { decision: "replay", result: "kept" });
});

test("complete 重复调用：拒绝覆盖，replay 保持首次结果", () => {
  const store = createIdempotencyStore({ now: createClock().now });
  store.begin(request("once"));
  assert.deepEqual(store.complete({ key: "once", result: "first" }), { ok: true });
  assert.deepEqual(store.complete({ key: "once", result: "second" }), { ok: false, reason: "already-completed" });
  assert.deepEqual(store.begin(request("once")), { decision: "replay", result: "first" });
});

test("不修改传入 params：冻结对象可用，指纹与执行前后不变", () => {
  const store = createIdempotencyStore({ now: createClock().now });
  const params = deepFreeze({ z: 1, a: { list: [3, 1, 2], nested: { b: true } } });
  const before = JSON.stringify(params);
  const fingerprint = fingerprintRequest("file.rename", params);
  assert.equal(typeof fingerprint, "string");

  assert.equal(store.begin({ key: "frozen", action: "file.rename", params }).decision, "execute");
  store.complete({ key: "frozen", result: "ok" });
  assert.equal(store.begin({ key: "frozen", action: "file.rename", params }).decision, "replay");
  assert.equal(JSON.stringify(params), before);
  assert.ok(Object.isFrozen(params));
});

test("参数序列化超过 4096 字符：指纹截断并记录 params-truncated", () => {
  const store = createIdempotencyStore({ now: createClock().now });
  const params = { blob: "x".repeat(5_000) };
  const fingerprint = fingerprintRequest("upload", params);
  assert.equal(fingerprint.length, "6:upload:".length + 4_096);

  assert.equal(store.begin({ key: "big", action: "upload", params }).decision, "execute");
  assert.deepEqual(store.lookup("big").notes, ["params-truncated"]);
  store.complete({ key: "big", result: "done" });
  assert.deepEqual(store.begin({ key: "big", action: "upload", params }), { decision: "replay", result: "done" });
  assert.equal(store.lookup("big").notes.includes("params-truncated"), true);
});

test("构造参数：非法 ttlMs/maxRecords/now 抛 TypeError", () => {
  assert.throws(() => createIdempotencyStore({ ttlMs: 0 }), TypeError);
  assert.throws(() => createIdempotencyStore({ ttlMs: 1.5 }), TypeError);
  assert.throws(() => createIdempotencyStore({ ttlMs: Number.MAX_SAFE_INTEGER + 1 }), TypeError);
  assert.throws(() => createIdempotencyStore({ maxRecords: 0 }), TypeError);
  assert.throws(() => createIdempotencyStore({ maxRecords: 1.5 }), TypeError);
  assert.throws(() => createIdempotencyStore({ now: 5 }), TypeError);
  assert.throws(() => createIdempotencyStore({ now: () => "later" }).size(), TypeError);
  assert.throws(() => createIdempotencyStore({ now: () => Number.NaN }).size(), TypeError);
});

test("源码纯度：零 import、零 require、无 fs/http/crypto/fetch", () => {
  const source = readFileSync(MODULE_URL, "utf8");
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");
  assert.doesNotMatch(code, /^\s*import\s/mu);
  assert.doesNotMatch(code, /\brequire\s*\(/u);
  assert.doesNotMatch(code, /\b(?:crypto|node:fs|node:http|node:https|node:net|child_process|worker_threads)\b/u);
  assert.doesNotMatch(code, /\bfetch\s*\(/u);
  assert.doesNotMatch(code, /\b(?:process|Buffer)\s*\./u);
});

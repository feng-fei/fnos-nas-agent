import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MAX_DIAGNOSIS_ENTRIES,
  DEFAULT_STALE_AFTER_MS,
  DIAGNOSIS_OUTCOMES,
  MAX_SYMPTOM_LENGTH,
  createDiagnosisHistory,
  redactDiagnosisText
} from "../apps/fnos-nas-agent/app/diagnosis-history.mjs";

function fixedClock(startIso = "2026-10-01T00:00:00.000Z") {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current).toISOString(),
    advance(ms) {
      current += ms;
    },
    set(iso) {
      current = Date.parse(iso);
    }
  };
}

function seqIds(prefix = "d") {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
}

function makeHistory(options = {}) {
  const clock = fixedClock();
  const history = createDiagnosisHistory({
    now: clock.now,
    id: seqIds(),
    ...options
  });
  return { history, clock };
}

test("常量与约定一致", () => {
  assert.equal(DEFAULT_MAX_DIAGNOSIS_ENTRIES, 200);
  assert.equal(DEFAULT_STALE_AFTER_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(MAX_SYMPTOM_LENGTH, 2048);
  assert.deepEqual([...DIAGNOSIS_OUTCOMES], ["open", "resolved", "ignored"]);
});

test("record 写入后可以读回", () => {
  const { history } = makeHistory();
  const result = history.record({
    symptom: "存储池显示降级",
    causes: ["磁盘 3 SMART 失败"],
    evidenceRefs: ["audit:12"],
    actions: ["读取 SMART 日志"],
    outcome: "open",
    note: "等待进一步确认"
  });
  assert.equal(result.recorded, true);
  assert.equal(result.entry.symptom, "存储池显示降级");
  assert.deepEqual(result.entry.causes, ["磁盘 3 SMART 失败"]);
  assert.deepEqual(result.entry.evidenceRefs, ["audit:12"]);
  assert.deepEqual(result.entry.actions, ["读取 SMART 日志"]);
  assert.equal(result.entry.outcome, "open");
  assert.equal(result.entry.corrections.length, 0);
  assert.equal(result.entry.stale, false);

  const fetched = history.get(result.entry.id);
  assert.equal(fetched.symptom, "存储池显示降级");
});

test("record 拒绝空症状与超长症状", () => {
  const { history } = makeHistory();
  const empty = history.record({ symptom: "   " });
  assert.equal(empty.recorded, false);
  assert.equal(empty.code, "invalid-symptom");

  const tooLong = history.record({ symptom: "x".repeat(MAX_SYMPTOM_LENGTH + 1) });
  assert.equal(tooLong.recorded, false);
  assert.equal(tooLong.code, "symptom-too-long");
});

test("record 拒绝非法结论状态", () => {
  const { history } = makeHistory();
  const result = history.record({ symptom: "x", outcome: "done" });
  assert.equal(result.recorded, false);
  assert.equal(result.code, "invalid-outcome");
});

test("超出上限时丢弃最旧的条目", () => {
  const { history, clock } = makeHistory({ maxEntries: 3 });
  const ids = [];
  for (let index = 0; index < 5; index += 1) {
    const result = history.record({ symptom: `症状 ${index}` });
    ids.push(result.entry.id);
    clock.advance(1000);
  }
  const listed = history.list();
  assert.equal(listed.total, 3);
  assert.deepEqual(listed.entries.map(entry => entry.symptom).sort(), ["症状 2", "症状 3", "症状 4"]);
  assert.equal(history.get(ids[0]), null);
  assert.equal(history.get(ids[1]), null);
  assert.notEqual(history.get(ids[2]), null);
});

test("list 支持症状过滤与分页", () => {
  const { history } = makeHistory();
  history.record({ symptom: "磁盘阵列降级" });
  history.record({ symptom: "磁盘阵列重建" });
  history.record({ symptom: "网络不通" });

  const filtered = history.list({ symptom: "磁盘" });
  assert.equal(filtered.total, 2);
  assert.ok(filtered.entries.every(entry => entry.symptom.includes("磁盘")));

  const paged = history.list({ limit: 1, offset: 1 });
  assert.equal(paged.limit, 1);
  assert.equal(paged.offset, 1);
  assert.equal(paged.entries.length, 1);
  assert.equal(paged.total, 3);
});

test("update 可以改结论与备注，非法更新被拒绝", () => {
  const { history } = makeHistory();
  const created = history.record({ symptom: "网络不通", note: "初始" });
  const updated = history.update(created.entry.id, { outcome: "resolved", note: "换网线后恢复" });
  assert.equal(updated.updated, true);
  assert.equal(updated.entry.outcome, "resolved");
  assert.equal(updated.entry.note, "换网线后恢复");

  const bad = history.update(created.entry.id, { outcome: "nope" });
  assert.equal(bad.updated, false);
  assert.equal(bad.code, "invalid-outcome");

  const missing = history.update("not-exist", { note: "x" });
  assert.equal(missing.updated, false);
  assert.equal(missing.code, "not-found");
});

test("remove 删除条目并对不存在条目报错", () => {
  const { history } = makeHistory();
  const created = history.record({ symptom: "临时症状" });
  const removed = history.remove(created.entry.id);
  assert.equal(removed.removed, true);
  assert.equal(history.get(created.entry.id), null);
  const again = history.remove(created.entry.id);
  assert.equal(again.removed, false);
  assert.equal(again.code, "not-found");
});

test("超过 7 天的 open 条目被标记过期并给出复核提示", () => {
  const { history, clock } = makeHistory();
  const created = history.record({ symptom: "存储降级" });
  clock.advance(DEFAULT_STALE_AFTER_MS + 1000);
  const stale = history.markStale(created.entry.id);
  assert.equal(stale.stale, true);
  assert.equal(stale.alreadyStale, false);
  assert.match(stale.prompt, /建议复核或归档/);
  assert.equal(stale.entry.stale, true);
  // 结论没有被自动改掉，条目也没有被删除。
  assert.equal(stale.entry.outcome, "open");
  assert.notEqual(history.get(created.entry.id), null);
});

test("刚好 7 天不算过期，超过 1 毫秒才算", () => {
  const { history, clock } = makeHistory();
  const created = history.record({ symptom: "边界症状" });
  clock.advance(DEFAULT_STALE_AFTER_MS);
  const onBoundary = history.markStale(created.entry.id);
  assert.equal(onBoundary.stale, false);
  assert.equal(onBoundary.code, "not-expired");

  clock.advance(1);
  const after = history.markStale(created.entry.id);
  assert.equal(after.stale, true);
});

test("已解决或已忽略的条目不会被标记过期", () => {
  const { history, clock } = makeHistory();
  const resolved = history.record({ symptom: "已解决症状", outcome: "resolved" });
  const ignored = history.record({ symptom: "已忽略症状", outcome: "ignored" });
  clock.advance(DEFAULT_STALE_AFTER_MS + 1000);
  const first = history.markStale(resolved.entry.id);
  assert.equal(first.stale, false);
  assert.equal(first.code, "not-open");
  const second = history.markStale(ignored.entry.id);
  assert.equal(second.stale, false);
  assert.equal(second.code, "not-open");
});

test("重复 markStale 是幂等的", () => {
  const { history, clock } = makeHistory();
  const created = history.record({ symptom: "幂等症状" });
  clock.advance(DEFAULT_STALE_AFTER_MS + 1000);
  const first = history.markStale(created.entry.id);
  const second = history.markStale(created.entry.id);
  assert.equal(second.stale, true);
  assert.equal(second.alreadyStale, true);
  assert.equal(second.entry.staleAt, first.entry.staleAt);
});

test("applyCorrection 追加修正事件且保留原始条目", () => {
  const { history } = makeHistory();
  const created = history.record({
    symptom: "容器反复重启",
    causes: ["内存不足"],
    note: "初次结论"
  });
  const corrected = history.applyCorrection(created.entry.id, {
    outcome: "resolved",
    note: "实际是磁盘满，扩容后恢复",
    correctedBy: "operator"
  });
  assert.equal(corrected.corrected, true);
  assert.equal(corrected.correction.previousOutcome, "open");
  assert.equal(corrected.correction.outcome, "resolved");
  assert.equal(corrected.correction.correctedBy, "operator");
  assert.match(corrected.correction.note, /磁盘满/);
  // 原始条目没有被抹掉。
  const entry = history.get(created.entry.id);
  assert.equal(entry.symptom, "容器反复重启");
  assert.deepEqual(entry.causes, ["内存不足"]);
  assert.equal(entry.corrections.length, 1);
  assert.equal(entry.outcome, "resolved");
  assert.equal(entry.corrections[0].previousOutcome, "open");
});

test("applyCorrection 对不存在的条目与非法结论报错", () => {
  const { history } = makeHistory();
  const created = history.record({ symptom: "x" });
  const missing = history.applyCorrection("nope", { outcome: "resolved" });
  assert.equal(missing.corrected, false);
  assert.equal(missing.code, "not-found");
  const bad = history.applyCorrection(created.entry.id, { outcome: "done" });
  assert.equal(bad.corrected, false);
  assert.equal(bad.code, "invalid-outcome");
});

test("suggestCorrections 按症状给出提示", () => {
  const { history, clock } = makeHistory();
  history.record({ symptom: "存储降级", outcome: "resolved" });
  const open = history.record({ symptom: "存储降级再次出现" });
  history.record({ symptom: "无关症状" });
  clock.advance(DEFAULT_STALE_AFTER_MS + 1000);
  history.markStale(open.entry.id);

  const suggestions = history.suggestCorrections({ symptom: "存储降级" });
  assert.equal(suggestions.total, 2);
  assert.ok(suggestions.suggestions.every(item => item.prompt));
  const prompts = suggestions.suggestions.map(item => item.prompt);
  assert.ok(prompts.some(prompt => /建议复核或归档/.test(prompt)));
  assert.ok(prompts.some(prompt => /已解决/.test(prompt)));
});

test("suggestCorrections 对空症状返回空结果", () => {
  const { history } = makeHistory();
  history.record({ symptom: "x" });
  const suggestions = history.suggestCorrections({ symptom: "  " });
  assert.deepEqual(suggestions.suggestions, []);
  assert.equal(suggestions.total, 0);
});

test("stats 给出总数、状态分布、过期数与症状聚合", () => {
  const { history, clock } = makeHistory();
  history.record({ symptom: "存储降级" });
  history.record({ symptom: "存储降级" });
  history.record({ symptom: "网络不通", outcome: "resolved" });
  history.record({ symptom: "无关现象", outcome: "ignored" });
  const open = history.record({ symptom: "长期未闭环" });
  clock.advance(DEFAULT_STALE_AFTER_MS + 1000);
  history.markStale(open.entry.id);

  const stats = history.stats();
  assert.equal(stats.total, 5);
  assert.equal(stats.byOutcome.open, 3);
  assert.equal(stats.byOutcome.resolved, 1);
  assert.equal(stats.byOutcome.ignored, 1);
  assert.equal(stats.stale, 1);
  const top = stats.bySymptom[0];
  assert.equal(top.symptom, "存储降级");
  assert.equal(top.count, 2);
  assert.equal(stats.bySymptom.length, 4);
});

test("症状与备注里的疑似密钥会被脱敏", () => {
  const { history } = makeHistory();
  const created = history.record({
    symptom: "登录失败 apiKey=sk-abcdefghijklmnopqrstuvwxyz",
    note: "密码: hunter2000"
  });
  assert.equal(created.recorded, true);
  assert.doesNotMatch(created.entry.symptom, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.match(created.entry.symptom, /\[已隐藏\]|\[已隐藏令牌\]/);
  assert.doesNotMatch(created.entry.note, /hunter2000/);
  assert.match(created.entry.note, /\[已隐藏\]/);
  assert.ok(created.entry.redactedFields.length > 0);
});

test("redactDiagnosisText 直接可用且报告被触碰的字段名", () => {
  const result = redactDiagnosisText("apiKey=abc123 token: xyz789");
  assert.doesNotMatch(result.text, /abc123/);
  assert.doesNotMatch(result.text, /xyz789/);
  assert.ok(result.fields.includes("apikey"));
});

test("非法入参被安全拒绝", () => {
  const { history } = makeHistory();
  assert.equal(history.record(null).recorded, false);
  assert.equal(history.record({ symptom: "x", causes: "not-array" }).code, "invalid-causes");
  assert.equal(history.record({ symptom: "x", evidenceRefs: "not-array" }).code, "invalid-evidence");
  assert.equal(history.record({ symptom: "x", actions: "not-array" }).code, "invalid-actions");
  assert.equal(history.record({ symptom: "x", note: "y".repeat(2000) }).code, "note-too-long");
});

test("createDiagnosisHistory 拒绝非法参数", () => {
  assert.throws(() => createDiagnosisHistory({ maxEntries: 0 }), TypeError);
  assert.throws(() => createDiagnosisHistory({ staleAfterMs: -1 }), TypeError);
  assert.throws(() => createDiagnosisHistory({ now: "x" }), TypeError);
  assert.throws(() => createDiagnosisHistory({ id: "x" }), TypeError);
});

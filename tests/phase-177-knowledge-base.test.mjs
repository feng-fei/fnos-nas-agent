import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_STALE_AFTER_MS,
  KNOWLEDGE_SOURCES,
  KNOWLEDGE_VERIFICATION_STATES,
  MAX_BODY_LENGTH,
  createKnowledgeBase,
  compareKnowledgeFacts,
  detectKnowledgeConflicts,
  evaluateKnowledgeExpiry,
  inspectKnowledgeBody,
  normalizeKnowledgeEntry,
  redactKnowledgeText,
  referenceKnowledgeEntry,
  reviewKnowledgeUpdates,
  searchKnowledgeEntries
} from "../apps/fnos-nas-agent/app/knowledge-base.mjs";

function fixedNow(value) {
  return () => value;
}

function makeInput(overrides = {}) {
  return {
    title: "存储池扩容流程",
    topic: "storage-pool-expansion",
    summary: "在 fnOS 存储管理中扩容存储池的标准步骤。",
    body: "扩容前先确认至少两块在线硬盘处于健康状态，再在存储管理界面执行扩容。",
    source: "official-doc",
    verification: "verified",
    category: "storage",
    tags: ["存储", "扩容"],
    facts: [{ name: "fnos.version", value: "1.2.3", collectedAt: "2026-10-01T00:00:00.000Z" }],
    ...overrides
  };
}

test("常量与枚举符合清单约定", () => {
  assert.equal(DEFAULT_MAX_ENTRIES, 500);
  assert.equal(DEFAULT_STALE_AFTER_MS, 30 * 24 * 60 * 60 * 1000);
  assert.deepEqual(KNOWLEDGE_SOURCES, ["official-doc", "field-observation", "manual-confirmation"]);
  assert.deepEqual(KNOWLEDGE_VERIFICATION_STATES, ["verified", "unverified", "stale", "conflicted"]);
  assert.equal(MAX_BODY_LENGTH, 8000);
});

test("K03 规范化条目保留来源、采集时间与验证状态", () => {
  const result = normalizeKnowledgeEntry(makeInput(), { now: "2026-10-20T00:00:00.000Z" });
  assert.equal(result.ok, true);
  assert.equal(result.entry.source, "official-doc");
  assert.equal(result.entry.collectedAt, "2026-10-20T00:00:00.000Z");
  assert.equal(result.entry.verification, "verified");
  assert.equal(result.entry.speculative, false);
});

test("K03 非法来源被拒绝", () => {
  const result = normalizeKnowledgeEntry(makeInput({ source: "gossip" }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "knowledge-invalid-source");
});

test("K03 未验证条目被标记为推测并在引用时给出推测标签", () => {
  const result = normalizeKnowledgeEntry(makeInput({ verification: "unverified" }));
  assert.equal(result.ok, true);
  assert.equal(result.entry.speculative, true);
  assert.ok(result.warnings.includes("entry-is-unverified"));

  const reference = referenceKnowledgeEntry(result.entry);
  assert.equal(reference.ok, true);
  assert.equal(reference.reference.speculative, true);
  assert.equal(reference.reference.label, "推测");
  assert.equal(reference.reference.confidence, "speculative");
  assert.match(reference.reference.warning, /推测/);
});

test("K03 已验证条目引用时不带推测标签", () => {
  const result = normalizeKnowledgeEntry(makeInput());
  const reference = referenceKnowledgeEntry(result.entry);
  assert.equal(reference.reference.speculative, false);
  assert.equal(reference.reference.label, "已验证");
  assert.equal(reference.reference.warning, null);
});

test("K04 检索支持关键词、标签与类别过滤", () => {
  const entries = [
    { id: "a", title: "扩容流程", summary: "存储池", body: "", tags: ["存储"], category: "storage", source: "official-doc", confidence: "high", verification: "verified", updatedAt: "2026-10-02T00:00:00.000Z" },
    { id: "b", title: "网络排查", summary: "端口", body: "", tags: ["网络"], category: "network", source: "field-observation", confidence: "medium", verification: "unverified", updatedAt: "2026-10-03T00:00:00.000Z" }
  ];
  const byKeyword = searchKnowledgeEntries(entries, { keyword: "存储" });
  assert.equal(byKeyword.entries.length, 1);
  assert.equal(byKeyword.entries[0].id, "a");

  const byTag = searchKnowledgeEntries(entries, { tag: "网络" });
  assert.equal(byTag.entries[0].id, "b");

  const byCategory = searchKnowledgeEntries(entries, { category: "storage" });
  assert.equal(byCategory.entries[0].id, "a");

  const bySource = searchKnowledgeEntries(entries, { source: "field-observation" });
  assert.equal(bySource.entries[0].id, "b");
});

test("K04 检索结果返回约定字段并有上限与去重", () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({
    id: `dup-${index % 5}`,
    title: "同一条目",
    summary: "摘要",
    body: "",
    tags: [],
    category: "c",
    source: "official-doc",
    confidence: "high",
    verification: "verified",
    updatedAt: "2026-10-01T00:00:00.000Z"
  }));
  const result = searchKnowledgeEntries(entries, {}, { limit: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 3);
  assert.equal(result.limit, 3);
  assert.equal(new Set(result.entries.map((entry) => entry.id)).size, result.entries.length);
  for (const key of ["id", "title", "summary", "source", "confidence", "updatedAt"]) {
    assert.ok(key in result.entries[0], `missing field ${key}`);
  }
});

test("K04 未验证条目在检索结果中排后面且可信度为推测", () => {
  const entries = [
    { id: "unverified", title: "推测条目", summary: "", body: "", tags: [], category: "", source: "field-observation", verification: "unverified", updatedAt: "2026-10-05T00:00:00.000Z" },
    { id: "verified", title: "已验证条目", summary: "", body: "", tags: [], category: "", source: "manual-confirmation", verification: "verified", updatedAt: "2026-10-01T00:00:00.000Z" }
  ];
  const result = searchKnowledgeEntries(entries, {});
  assert.equal(result.entries[0].id, "verified");
  assert.equal(result.entries[1].confidence, "speculative");
});

test("K05 事实携带采集时间且不冒充当前值", () => {
  const result = normalizeKnowledgeEntry(makeInput());
  assert.equal(result.entry.facts[0].collectedAt, "2026-10-01T00:00:00.000Z");
  const reference = referenceKnowledgeEntry(result.entry);
  assert.equal(reference.reference.factsAsOf[0].collectedAt, "2026-10-01T00:00:00.000Z");
});

test("K05 当前值变化时返回 stale 标志与差异", () => {
  const result = normalizeKnowledgeEntry(makeInput());
  const comparison = compareFact(result.entry, { "fnos.version": "1.3.0" });
  assert.equal(comparison.stale, true);
  assert.equal(comparison.changed.length, 1);
  assert.equal(comparison.changed[0].recordedValue, "1.2.3");
  assert.equal(comparison.changed[0].currentValue, "1.3.0");
  assert.match(comparison.note, /不代表当前状态/);
});

function compareFact(entry, current) {
  return compareKnowledgeFacts(entry, current, { now: "2026-10-20T00:00:00.000Z" });
}

test("K05 当前值未变化时不标记 stale", () => {
  const result = normalizeKnowledgeEntry(makeInput());
  const comparison = compareFact(result.entry, { "fnos.version": "1.2.3" });
  assert.equal(comparison.stale, false);
  assert.equal(comparison.changed.length, 0);
});

test("K08 正文超长被拒绝", () => {
  const result = normalizeKnowledgeEntry(makeInput({ body: "x".repeat(MAX_BODY_LENGTH + 1) }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "knowledge-body-too-long");
});

test("K08 密钥只回报字段名不落原文", () => {
  const redacted = redactKnowledgeText("apiKey: super-secret-value token=abcdefghijkl");
  assert.equal(redacted.text.includes("super-secret-value"), false);
  assert.equal(redacted.text.includes("abcdefghijkl"), false);
  assert.ok(redacted.fields.includes("apiKey"));
  assert.ok(redacted.fields.includes("token"));
  assert.match(redacted.text, /\[已隐藏\]/);
});

test("K08 无字段名的令牌形态也被抹除", () => {
  const redacted = redactKnowledgeText("使用 sk-abcdefghijklmnopqrstuvwx 登录");
  assert.equal(redacted.text.includes("sk-abcdefghijklmnopqrstuvwx"), false);
  assert.match(redacted.text, /\[已隐藏令牌\]/);
});

test("K08 写入时正文里的密钥被替换并回报字段名", () => {
  const result = normalizeKnowledgeEntry(
    makeInput({ body: "登录时使用 apiKey=abcd1234efgh 完成鉴权后继续配置。" })
  );
  assert.equal(result.ok, true);
  assert.equal(result.entry.body.includes("abcd1234efgh"), false);
  assert.ok(result.redactedFields.includes("apiKey"));
  assert.ok(result.warnings.includes("secret-material-redacted"));
});

test("K08 拒绝保存提示词原文、异常栈与绝对本机路径", () => {
  const prompt = inspectKnowledgeBody("<|im_start|>system 你是一个助手");
  assert.equal(prompt.ok, false);
  assert.ok(prompt.reasons.includes("prompt-original"));

  const stack = inspectKnowledgeBody("Error: boom\n    at run (file.js:12:3)");
  assert.equal(stack.ok, false);
  assert.ok(stack.reasons.includes("stack-trace"));

  const path = inspectKnowledgeBody("配置文件位于 /home/admin/agent/config.json");
  assert.equal(path.ok, false);
  assert.ok(path.reasons.includes("absolute-local-path"));
});

test("K08 写操作必须先预览再提交，预览阶段不落库", () => {
  const base = createKnowledgeBase({ now: fixedNow("2026-10-20T00:00:00.000Z") });
  const preview = base.preview("write", { ...makeInput(), id: "kb-1" });
  assert.equal(preview.ok, true);
  assert.equal(preview.entry.id, "kb-1");
  assert.equal(base.get("kb-1").ok, false);

  const committed = base.commit(preview.previewId);
  assert.equal(committed.ok, true);
  assert.equal(committed.written, true);
  assert.equal(base.get("kb-1").ok, true);
});

test("K08 拒绝覆盖同 id，force 时记录版本", () => {
  const base = createKnowledgeBase({ now: fixedNow("2026-10-20T00:00:00.000Z") });
  const first = base.preview("write", { ...makeInput(), id: "kb-1" });
  base.commit(first.previewId);

  const blocked = base.preview("write", { ...makeInput({ summary: "第二版摘要。" }), id: "kb-1" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "knowledge-duplicate-id");

  const forced = base.preview("write", { ...makeInput({ summary: "第二版摘要。" }), id: "kb-1", force: true });
  assert.equal(forced.ok, true);
  assert.ok(forced.warnings.includes("entry-replaced-with-force"));
  const committed = base.commit(forced.previewId);
  assert.equal(committed.ok, true);
  assert.equal(committed.entry.versions.length, 1);
  assert.equal(committed.entry.versions[0].version, 1);
});

test("K08 未确认的预览可以取消", () => {
  const base = createKnowledgeBase({ now: fixedNow("2026-10-20T00:00:00.000Z") });
  const preview = base.preview("write", { ...makeInput(), id: "kb-2" });
  const cancelled = base.cancel(preview.previewId);
  assert.equal(cancelled.ok, true);
  assert.equal(base.commit(preview.previewId).code, "knowledge-preview-not-found");
  assert.equal(base.get("kb-2").ok, false);
});

test("K09 版本变化时返回需要复核的条目清单", () => {
  const base = createKnowledgeBase({ now: fixedNow("2026-10-20T00:00:00.000Z") });
  const preview = base.preview("write", { ...makeInput(), id: "kb-3" });
  base.commit(preview.previewId);

  const unchanged = base.review({ "fnos.version": "1.2.3" });
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.changed.length, 0);

  const changed = base.review({ "fnos.version": "1.3.0" });
  assert.equal(changed.changed.length, 1);
  assert.equal(changed.changed[0].id, "kb-3");
  assert.equal(changed.changed[0].changedFacts[0].currentValue, "1.3.0");
  assert.match(changed.changed[0].prompt, /复核/);
});

test("K09 纯函数版本同样可单独使用", () => {
  const entries = [
    { id: "kb-4", title: "T", facts: [{ name: "app.version", value: "2.0.0", collectedAt: "2026-10-01T00:00:00.000Z" }], verification: "verified" }
  ];
  const result = reviewKnowledgeUpdates(entries, { "app.version": "2.1.0" });
  assert.equal(result.ok, true);
  assert.equal(result.total, 1);
  assert.equal(result.changed[0].changedFacts[0].name, "app.version");
});

test("K10 同一主题冲突结论时返回冲突标记而不是随便选一个", () => {
  const entries = [
    { id: "c1", title: "结论 A", topic: "disk-usage", conclusion: "占用率为 80%", source: "official-doc", verification: "verified", collectedAt: "2026-10-01T00:00:00.000Z" },
    { id: "c2", title: "结论 B", topic: "disk-usage", conclusion: "占用率为 40%", source: "field-observation", verification: "unverified", collectedAt: "2026-10-02T00:00:00.000Z" }
  ];
  const result = detectKnowledgeConflicts(entries);
  assert.equal(result.ok, true);
  assert.equal(result.total, 1);
  assert.equal(result.conflicts[0].topic, "disk-usage");
  assert.equal(result.conflicts[0].entries.length, 2);
  assert.equal(result.conflicts[0].resolution, null);
});

test("K10 无冲突时不返回冲突项", () => {
  const entries = [
    { id: "c1", title: "结论 A", topic: "disk-usage", conclusion: "占用率为 80%", source: "official-doc", verification: "verified" }
  ];
  const result = detectKnowledgeConflicts(entries);
  assert.equal(result.total, 0);
});

test("K10 超期条目标记 expired", () => {
  const entries = [
    { id: "e1", title: "过期条目", verification: "verified", collectedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-06-01T00:00:00.000Z" },
    { id: "e2", title: "未过期条目", verification: "verified", collectedAt: "2026-10-19T00:00:00.000Z", expiresAt: "2026-12-01T00:00:00.000Z" }
  ];
  const result = evaluateKnowledgeExpiry(entries, { now: "2026-10-20T00:00:00.000Z" });
  assert.equal(result.ok, true);
  assert.equal(result.expired.length, 1);
  assert.equal(result.expired[0].id, "e1");
  assert.equal(result.expired.some((item) => item.id === "e2"), false);
});

test("K10 长期未验证条目标记为 stale", () => {
  const entries = [
    { id: "s1", title: "陈旧条目", verification: "unverified", collectedAt: "2026-01-01T00:00:00.000Z" }
  ];
  const result = evaluateKnowledgeExpiry(entries, { now: "2026-10-20T00:00:00.000Z" });
  assert.equal(result.stale.length, 1);
  assert.equal(result.stale[0].id, "s1");
});

test("refreshExpiry 会刷新过期与冲突标记", () => {
  const base = createKnowledgeBase({ now: fixedNow("2026-10-20T00:00:00.000Z") });
  const a = base.preview("write", {
    ...makeInput({ id: "x1", topic: "disk-usage", conclusion: "占用率 80%", expiresAt: "2026-06-01T00:00:00.000Z" }),
    id: "x1"
  });
  base.commit(a.previewId);
  const b = base.preview("write", {
    ...makeInput({ id: "x2", topic: "disk-usage", conclusion: "占用率 40%", verification: "unverified" }),
    id: "x2"
  });
  base.commit(b.previewId);

  const refreshed = base.refreshExpiry();
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.expired.length, 1);
  assert.equal(refreshed.conflicts.length, 1);
  assert.equal(base.get("x1").entry.verification, "conflicted");
  assert.equal(base.get("x1").entry.expired, true);
});

test("归档走两步接口，归档后不再出现在检索与列表中", () => {
  const base = createKnowledgeBase({ now: fixedNow("2026-10-20T00:00:00.000Z") });
  const write = base.preview("write", { ...makeInput(), id: "kb-5" });
  base.commit(write.previewId);

  const archive = base.preview("archive", { id: "kb-5" });
  assert.equal(archive.ok, true);
  assert.ok(archive.warnings.includes("entry-will-be-archived"));
  const committed = base.commit(archive.previewId);
  assert.equal(committed.archived, true);
  assert.equal(base.list().entries.length, 0);
  assert.equal(base.search({}).entries.length, 0);
});

test("验证状态变更走两步接口", () => {
  const base = createKnowledgeBase({ now: fixedNow("2026-10-20T00:00:00.000Z") });
  const write = base.preview("write", { ...makeInput({ verification: "unverified" }), id: "kb-6" });
  base.commit(write.previewId);
  assert.equal(base.get("kb-6").entry.speculative, true);

  const verify = base.preview("verify", { id: "kb-6", verification: "verified" });
  assert.equal(verify.ok, true);
  const committed = base.commit(verify.previewId);
  assert.equal(committed.entry.verification, "verified");
  assert.equal(committed.entry.speculative, false);
});

test("非法操作与非法 id 返回结构化错误", () => {
  const base = createKnowledgeBase();
  const badOperation = base.preview("destroy", {});
  assert.equal(badOperation.ok, false);
  assert.equal(badOperation.code, "knowledge-invalid-operation");

  const missing = base.preview("verify", { id: "nope" });
  assert.equal(missing.code, "knowledge-not-found");

  const badCommit = base.commit("preview-unknown");
  assert.equal(badCommit.code, "knowledge-preview-not-found");
});

test("存储接口可注入，load 的条目可被检索", () => {
  const stored = [
    {
      id: "loaded-1",
      title: "已加载条目",
      summary: "摘要",
      body: "",
      category: "",
      source: "manual-confirmation",
      verification: "verified",
      confidence: "high",
      tags: ["x"],
      facts: [],
      collectedAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      archived: false
    }
  ];
  const saved = [];
  const base = createKnowledgeBase({
    storage: { load: () => stored, save: (entries) => saved.push(entries) },
    now: fixedNow("2026-10-20T00:00:00.000Z")
  });
  assert.equal(base.get("loaded-1").ok, true);
  const write = base.preview("write", { ...makeInput(), id: "kb-7" });
  base.commit(write.previewId);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].length, 2);
});

test("条目数超过上限时丢弃最旧条目", () => {
  const base = createKnowledgeBase({ maxEntries: 2, now: fixedNow("2026-10-20T00:00:00.000Z") });
  for (const id of ["k1", "k2", "k3"]) {
    const preview = base.preview("write", { ...makeInput(), id });
    base.commit(preview.previewId);
  }
  assert.equal(base.stats().total, 2);
  assert.equal(base.get("k1").ok, false);
});

test("构造参数非法时抛出 TypeError", () => {
  assert.throws(() => createKnowledgeBase({ maxEntries: 0 }), TypeError);
  assert.throws(() => createKnowledgeBase({ staleAfterMs: -1 }), TypeError);
  assert.throws(() => createKnowledgeBase({ now: 123 }), TypeError);
});

test("stats 汇总来源与验证状态分布", () => {
  const base = createKnowledgeBase({ now: fixedNow("2026-10-20T00:00:00.000Z") });
  const a = base.preview("write", { ...makeInput(), id: "s1" });
  base.commit(a.previewId);
  const b = base.preview("write", { ...makeInput({ source: "field-observation", verification: "unverified" }), id: "s2" });
  base.commit(b.previewId);

  const stats = base.stats();
  assert.equal(stats.ok, true);
  assert.equal(stats.total, 2);
  assert.equal(stats.bySource["official-doc"], 1);
  assert.equal(stats.bySource["field-observation"], 1);
  assert.equal(stats.byVerification.verified, 1);
  assert.equal(stats.byVerification.unverified, 1);
});

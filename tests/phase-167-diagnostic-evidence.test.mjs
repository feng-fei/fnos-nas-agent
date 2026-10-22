import test from "node:test";
import assert from "node:assert/strict";

import {
  DIAGNOSTIC_EVIDENCE_SOURCES,
  MAX_EVIDENCE_PER_SOURCE,
  MAX_EVIDENCE_TOTAL,
  collectDiagnosticEvidence,
  buildEvidenceBundle
} from "../apps/fnos-nas-agent/app/diagnostic-evidence.mjs";

function auditEntry(overrides = {}) {
  return {
    at: "2026-10-22T10:00:00.000Z",
    method: "POST",
    route: "/api/files/operation",
    statusCode: 500,
    outcome: "failure",
    toolId: "files.delete",
    risk: "destructive",
    target: "/vol1/photos",
    ...overrides
  };
}

function traceEntry(overrides = {}) {
  return {
    toolId: "files.read",
    risk: "read",
    outcome: "error",
    errorClass: "not-found",
    durationMs: 42,
    startedAt: "2026-10-22T10:00:01.000Z",
    ...overrides
  };
}

function healthCheck(overrides = {}) {
  return {
    name: "存储池健康",
    type: "storage",
    lastStatus: "warning",
    lastRunAt: "2026-10-22T09:00:00.000Z",
    lastSummary: "阵列降级",
    ...overrides
  };
}

function snapshotSection(overrides = {}) {
  return {
    id: "storage",
    title: "存储与硬盘健康",
    status: "warning",
    note: "阵列处于降级状态",
    values: { usedPercent: 87, raidState: "degraded", online: true },
    ...overrides
  };
}

test("DIAGNOSTIC_EVIDENCE_SOURCES 暴露四个允许的来源", () => {
  assert.deepEqual([...DIAGNOSTIC_EVIDENCE_SOURCES], ["audit", "trace", "health-check", "snapshot"]);
});

test("审计来源可以产出证据并带上时间戳", () => {
  const evidence = collectDiagnosticEvidence({ auditEntries: [auditEntry()] });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].source, "audit");
  assert.match(evidence[0].detail, /POST \/api\/files\/operation/);
  assert.match(evidence[0].detail, /status=500/);
  assert.match(evidence[0].detail, /outcome=failure/);
  assert.equal(evidence[0].at, "2026-10-22T10:00:00.000Z");
});

test("轨迹来源可以产出证据", () => {
  const evidence = collectDiagnosticEvidence({ traceEntries: [traceEntry()] });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].source, "trace");
  assert.match(evidence[0].detail, /tool=files\.read/);
  assert.match(evidence[0].detail, /error=not-found/);
  assert.match(evidence[0].detail, /durationMs=42/);
});

test("定时巡检来源可以产出证据", () => {
  const evidence = collectDiagnosticEvidence({ healthChecks: [healthCheck()] });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].source, "health-check");
  assert.match(evidence[0].detail, /health-check 存储池健康/);
  assert.match(evidence[0].detail, /lastStatus=warning/);
});

test("系统快照来源可以产出证据（对象与数组两种形态）", () => {
  const fromObject = collectDiagnosticEvidence({
    snapshots: [{ generatedAt: "2026-10-22T09:30:00.000Z", sections: [snapshotSection()] }]
  });
  assert.equal(fromObject.length, 1);
  assert.equal(fromObject[0].source, "snapshot");
  assert.match(fromObject[0].detail, /存储与硬盘健康/);
  assert.match(fromObject[0].detail, /usedPercent=87/);

  const fromArray = collectDiagnosticEvidence({ snapshots: [snapshotSection()] });
  assert.equal(fromArray.length, 1);
  assert.equal(fromArray[0].source, "snapshot");
});

test("提示词不进入证据（白名单字段生效）", () => {
  const evidence = collectDiagnosticEvidence({
    auditEntries: [auditEntry({ prompt: "请帮我把 /vol1 全部格式化", userText: "把照片删掉" })]
  });
  assert.equal(evidence.length, 1);
  assert.doesNotMatch(evidence[0].detail, /格式化/);
  assert.doesNotMatch(evidence[0].detail, /prompt/i);
});

test("密钥原文不进入证据（字段名与赋值形态都被拦下）", () => {
  const evidence = collectDiagnosticEvidence({
    auditEntries: [auditEntry({ apiKey: "sk-live-abcdef123456", token: "abcd1234efgh5678" })],
    traceEntries: [traceEntry({ authorization: "Bearer sk-live-abcdef123456" })],
    healthChecks: [healthCheck({ lastSummary: "apiKey=sk-live-abcdef123456" })]
  });
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /sk-live-abcdef123456/);
  assert.doesNotMatch(serialized, /abcd1234efgh5678/);
  assert.doesNotMatch(serialized, /abcdef123456/);
  assert.match(serialized, /\[redacted\]/);
});

test("原始异常栈不进入证据", () => {
  const evidence = collectDiagnosticEvidence({
    traceEntries: [traceEntry({ errorClass: "Error: boom\n    at Foo.bar (/app/x.js:1:1)\n    at Baz.qux (/app/y.js:2:2)" })]
  });
  assert.equal(evidence.length, 1);
  assert.doesNotMatch(evidence[0].detail, /\/app\/x\.js/);
  assert.doesNotMatch(evidence[0].detail, /at Foo\.bar/);
});

test("快照里非白名单的数值键不进入证据", () => {
  const evidence = collectDiagnosticEvidence({
    snapshots: [{ sections: [snapshotSection({ values: { usedPercent: 42, secretMetric: 99, apiKey: "sk-x" } })] }]
  });
  assert.equal(evidence.length, 1);
  assert.match(evidence[0].detail, /usedPercent=42/);
  assert.doesNotMatch(evidence[0].detail, /secretMetric/);
  assert.doesNotMatch(evidence[0].detail, /99/);
});

test("每个来源的证据条数被截断并留下 truncated 标记", () => {
  const many = Array.from({ length: MAX_EVIDENCE_PER_SOURCE + 25 }, (_, index) =>
    auditEntry({ route: `/api/route-${index}` })
  );
  const evidence = collectDiagnosticEvidence({ auditEntries: many });
  assert.equal(evidence.length, MAX_EVIDENCE_PER_SOURCE);
  assert.equal(evidence[evidence.length - 1].truncated, true);
  assert.equal(evidence[0].truncated, undefined);
});

test("总证据条数有上限，超出时打上 truncated 标记", () => {
  const perSource = Array.from({ length: MAX_EVIDENCE_PER_SOURCE }, (_, index) =>
    auditEntry({ route: `/api/a-${index}` })
  );
  const trace = Array.from({ length: MAX_EVIDENCE_PER_SOURCE }, (_, index) =>
    traceEntry({ toolId: `tool-${index}` })
  );
  const checks = Array.from({ length: MAX_EVIDENCE_PER_SOURCE }, (_, index) =>
    healthCheck({ name: `检查-${index}` })
  );
  const sections = Array.from({ length: MAX_EVIDENCE_PER_SOURCE }, (_, index) =>
    snapshotSection({ id: `section-${index}`, title: `分段-${index}` })
  );
  const evidence = collectDiagnosticEvidence({
    auditEntries: perSource,
    traceEntries: trace,
    healthChecks: checks,
    snapshots: [{ sections }]
  });
  assert.equal(evidence.length, MAX_EVIDENCE_TOTAL);
  assert.equal(evidence[evidence.length - 1].truncated, true);
});

test("重复证据只保留一条（同一症状不重复收录同一条证据）", () => {
  const duplicated = [auditEntry(), auditEntry(), auditEntry({ route: "/api/other" })];
  const bundle = buildEvidenceBundle({ auditEntries: duplicated, symptom: "files.delete 失败" });
  assert.equal(bundle.evidence.length, 2);
  assert.equal(bundle.stats.duplicatesRemoved, 1);
  assert.equal(bundle.stats.unique, 2);
  const details = bundle.evidence.map(item => item.detail);
  assert.equal(new Set(details).size, details.length);
});

test("buildEvidenceBundle 产出 buildDiagnosticReport 需要的 evidence 形状", () => {
  const bundle = buildEvidenceBundle({
    auditEntries: [auditEntry()],
    traceEntries: [traceEntry()],
    healthChecks: [healthCheck()],
    snapshots: [{ sections: [snapshotSection()] }]
  });
  assert.equal(bundle.evidence.length, 4);
  for (const item of bundle.evidence) {
    assert.equal(typeof item.source, "string");
    assert.equal(typeof item.detail, "string");
    assert.deepEqual(Object.keys(item).sort(), ["detail", "source"]);
  }
  assert.equal(bundle.truncated.total, false);
});

test("与症状相关的证据排在前面", () => {
  const bundle = buildEvidenceBundle({
    auditEntries: [auditEntry({ route: "/api/overview", toolId: "files.list" })],
    traceEntries: [traceEntry({ toolId: "files.delete" })],
    symptom: "files.delete"
  });
  assert.equal(bundle.evidence[0].source, "trace");
  assert.equal(bundle.stats.matched, 1);
});

test("空输入返回空数组且不臆造证据", () => {
  const evidence = collectDiagnosticEvidence();
  assert.deepEqual(evidence, []);

  const bundle = buildEvidenceBundle();
  assert.deepEqual(bundle.evidence, []);
  assert.equal(bundle.stats.collected, 0);
  assert.equal(bundle.stats.unique, 0);
  assert.equal(bundle.truncated.total, false);
});

test("maxEvidence 可以进一步收窄结果并记录被丢弃条数", () => {
  const bundle = buildEvidenceBundle({
    auditEntries: [auditEntry({ route: "/api/a" }), auditEntry({ route: "/api/b" })],
    maxEvidence: 1
  });
  assert.equal(bundle.evidence.length, 1);
  assert.equal(bundle.stats.limited, 1);
});

test("空字段与畸形记录被安全跳过", () => {
  const evidence = collectDiagnosticEvidence({
    auditEntries: [null, {}, "not-an-object"],
    traceEntries: [null, {}],
    healthChecks: [null, {}],
    snapshots: [null, {}, { sections: [null, {}] }]
  });
  // {} 之类的记录没有可展示字段，会被跳过；快照的 {} 至少能产出 "snapshot section" 明细。
  for (const item of evidence) {
    assert.equal(typeof item.detail, "string");
    assert.ok(item.detail.length > 0);
  }
  assert.ok(evidence.every(item => item.source === "audit" || item.source === "trace"
    || item.source === "health-check" || item.source === "snapshot"));
});

test("now 兜底时间戳会补到没有 at 的证据上", () => {
  const evidence = collectDiagnosticEvidence({
    auditEntries: [auditEntry({ at: undefined })],
    now: "2026-10-22T12:00:00.000Z"
  });
  assert.equal(evidence[0].at, "2026-10-22T12:00:00.000Z");
});

test("同一个来源的同名证据只保留一条，去重键包含来源", () => {
  const bundle = buildEvidenceBundle({
    auditEntries: [auditEntry()],
    traceEntries: [traceEntry({ outcome: "failure", errorClass: "" })]
  });
  // 两条明细文本不同（来源前缀不同），因此都保留。
  assert.equal(bundle.evidence.length, 2);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  summarizeAuditEntries,
  buildToolPermissionTable,
  runSecurityInspection,
  maskSecret,
  normalizeErrorMessage
} from "../apps/fnos-nas-agent/app/security-audit.mjs";

const CATALOG = [
  { id: "files.list", title: "列出文件", description: "列出目录内容", risk: "read-only", source: "builtin" },
  { id: "files.upload", title: "上传文件", description: "写入一个新文件", risk: "write", source: "builtin" },
  { id: "files.delete", title: "删除文件", description: "删除一个文件", risk: "destructive", source: "builtin" },
  { id: "skill:pack:run", title: "运行技能", description: "执行技能包", risk: "destructive", source: "skill" },
  { id: "mcp:nas-tools:volume.list", title: "列出存储卷", description: "外部 MCP 工具", risk: "read-only", source: "mcp" }
];

function findingIds(report, sectionId) {
  const section = report.sections.find(item => item.id === sectionId);
  return section ? section.findings.map(item => item.id) : [];
}

test("summarizeAuditEntries counts total, actions and outcomes", () => {
  const summary = summarizeAuditEntries([
    { route: "files.list", outcome: "success", at: "2026-01-01T00:00:00.000Z" },
    { route: "files.list", outcome: "success", at: "2026-01-01T00:00:01.000Z" },
    { route: "files.manage", outcome: "error", at: "2026-01-01T00:00:02.000Z", detail: "boom" },
    { route: "files.manage", outcome: "rejected", at: "2026-01-01T00:00:03.000Z", detail: "nope" }
  ]);
  assert.equal(summary.total, 4);
  assert.deepEqual(summary.byAction, { "files.list": 2, "files.manage": 2 });
  assert.deepEqual(summary.byOutcome, { success: 2, error: 1, rejected: 1 });
});

test("summarizeAuditEntries reports only the failures that happened at least twice", () => {
  const summary = summarizeAuditEntries([
    { route: "tools.run", outcome: "error", detail: "Request 42 failed for id 7" },
    { route: "tools.run", outcome: "error", detail: "Request 43 failed for id 9" },
    { route: "tools.run", outcome: "error", detail: "Request 44 failed for id 4" },
    { route: "files.list", outcome: "error", detail: "unique failure" }
  ]);
  assert.equal(summary.repeatedErrors.length, 1);
  assert.equal(summary.repeatedErrors[0].count, 3);
  assert.match(summary.repeatedErrors[0].message, /Request … failed for id …/);
  assert.doesNotMatch(summary.repeatedErrors[0].message, /42|43|44/);
});

test("summarizeAuditEntries normalizes timestamps and quoted identifiers out of the message", () => {
  const summary = summarizeAuditEntries([
    { route: "x", outcome: "error", detail: "failed at 2026-01-01T10:00:00.000Z" },
    { route: "x", outcome: "error", detail: "failed at 2025-12-31T23:59:59.000Z" }
  ]);
  assert.equal(summary.repeatedErrors.length, 1);
  assert.equal(summary.repeatedErrors[0].count, 2);
});

test("summarizeAuditEntries orders the repeated errors by count", () => {
  const entries = [];
  for (let index = 0; index < 4; index += 1) entries.push({ route: "a", outcome: "error", detail: "alpha failure" });
  for (let index = 0; index < 2; index += 1) entries.push({ route: "b", outcome: "error", detail: "beta failure" });
  const summary = summarizeAuditEntries(entries);
  assert.equal(summary.repeatedErrors[0].count, 4);
  assert.equal(summary.repeatedErrors[1].count, 2);
});

test("summarizeAuditEntries honours the limit", () => {
  const entries = [
    { route: "a", outcome: "error", detail: "alpha" },
    { route: "a", outcome: "error", detail: "alpha" },
    { route: "b", outcome: "error", detail: "beta" },
    { route: "b", outcome: "error", detail: "beta" }
  ];
  const summary = summarizeAuditEntries(entries, { limit: 1 });
  assert.equal(summary.repeatedErrors.length, 1);
});

test("summarizeAuditEntries lists the recent failures", () => {
  const summary = summarizeAuditEntries([
    { route: "files.list", outcome: "success", at: "2026-01-01T00:00:00.000Z" },
    { route: "files.manage", outcome: "error", at: "2026-01-01T00:00:05.000Z", detail: "disk full" },
    { route: "tools.run", outcome: "rejected", at: "2026-01-01T00:00:09.000Z", detail: "needs approval" }
  ]);
  assert.equal(summary.recentFailures.length, 2);
  assert.equal(summary.recentFailures[0].at, "2026-01-01T00:00:09.000Z");
  assert.equal(summary.recentFailures[0].action, "tools.run");
  assert.equal(summary.recentFailures[0].outcome, "rejected");
  assert.equal(summary.recentFailures[0].detail, "needs approval");
});

test("summarizeAuditEntries tolerates an empty or invalid input", () => {
  const summary = summarizeAuditEntries(undefined);
  assert.equal(summary.total, 0);
  assert.deepEqual(summary.byAction, {});
  assert.deepEqual(summary.byOutcome, {});
  assert.deepEqual(summary.repeatedErrors, []);
  assert.deepEqual(summary.recentFailures, []);
});

test("normalizeErrorMessage drops a message that only carries placeholders", () => {
  assert.equal(normalizeErrorMessage("1234 5678"), "");
  assert.equal(normalizeErrorMessage(""), "");
});

test("buildToolPermissionTable lists every tool with its source and risk", () => {
  const table = buildToolPermissionTable(CATALOG);
  assert.equal(table.length, 5);
  assert.deepEqual(table[0], {
    tool: "files.list",
    source: "builtin",
    risk: "read-only",
    requiresApproval: false,
    description: "列出目录内容"
  });
  assert.equal(table[2].tool, "files.delete");
  assert.equal(table[2].risk, "destructive");
  assert.equal(table[2].requiresApproval, true);
  assert.equal(table[4].source, "mcp");
});

test("buildToolPermissionTable marks the destructive tools as needing approval", () => {
  const table = buildToolPermissionTable(CATALOG);
  const destructive = table.filter(item => item.risk === "destructive");
  assert.equal(destructive.length, 2);
  assert.ok(destructive.every(item => item.requiresApproval === true));
});

test("buildToolPermissionTable accepts a widened approval list", () => {
  const table = buildToolPermissionTable(CATALOG, { approvalRequired: ["destructive", "write"] });
  const write = table.find(item => item.tool === "files.upload");
  assert.equal(write.requiresApproval, true);
  const read = table.find(item => item.tool === "files.list");
  assert.equal(read.requiresApproval, false);
});

test("buildToolPermissionTable accepts a {tools: []} wrapper and skips broken entries", () => {
  const table = buildToolPermissionTable({ tools: [{ id: "files.list", risk: "read-only", source: { kind: "builtin" } }, null, {}] });
  assert.equal(table.length, 1);
  assert.equal(table[0].source, "builtin");
});

test("buildToolPermissionTable reports an unknown risk instead of inventing one", () => {
  const table = buildToolPermissionTable([{ id: "weird.tool", risk: "super", source: "mcp" }]);
  assert.equal(table[0].risk, "unknown");
  assert.equal(table[0].requiresApproval, false);
});

test("maskSecret keeps only the first two characters and never the full value", () => {
  const masked = maskSecret("sk-abcdefghijklmnop");
  assert.equal(masked, "sk********");
  assert.ok(!masked.includes("abcdefghijklmnop"));
  assert.ok(!masked.includes("sk-abc"));
});

test("maskSecret returns an empty string for an empty or non string value", () => {
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret(null), "");
  assert.equal(maskSecret(1234), "");
});

test("runSecurityInspection returns the six fixed sections in a stable order", () => {
  const report = runSecurityInspection({});
  assert.deepEqual(report.sections.map(item => item.id), [
    "exposed-listen-address",
    "plaintext-secret-config",
    "destructive-tool-without-approval",
    "over-broad-file-root",
    "scheduled-check-failure",
    "repeated-audit-failure"
  ]);
  assert.ok(typeof report.generatedAt === "string" && !Number.isNaN(Date.parse(report.generatedAt)));
});

test("runSecurityInspection does not invent a finding when no data is passed", () => {
  const report = runSecurityInspection({});
  assert.equal(report.summary.total, 0);
  assert.deepEqual(report.summary, { critical: 0, warning: 0, info: 0, total: 0 });
  for (const section of report.sections) {
    assert.deepEqual(section.findings, []);
    assert.equal(section.severity, "info");
    assert.equal(section.summary, "未发现问题");
  }
});

test("runSecurityInspection reports an exposed listen address", () => {
  const report = runSecurityInspection({ config: { listenAddress: "0.0.0.0" } });
  const ids = findingIds(report, "exposed-listen-address");
  assert.equal(ids.length, 1);
  const finding = report.sections.find(item => item.id === "exposed-listen-address").findings[0];
  assert.equal(finding.severity, "warning");
  assert.match(finding.evidence, /config\.listenAddress/);
});

test("runSecurityInspection stays quiet for a loopback listen address", () => {
  const report = runSecurityInspection({ config: { listenAddress: "127.0.0.1" } });
  assert.deepEqual(findingIds(report, "exposed-listen-address"), []);
});

test("runSecurityInspection reports a plaintext secret and masks it in the evidence", () => {
  const report = runSecurityInspection({ config: { model: { apiKey: "sk-plaintext-secret-value" } } });
  const section = report.sections.find(item => item.id === "plaintext-secret-config");
  assert.equal(section.findings.length, 1);
  assert.equal(section.findings[0].severity, "critical");
  assert.match(section.findings[0].evidence, /config\.model\.apiKey/);
  assert.ok(!section.findings[0].evidence.includes("sk-plaintext-secret-value"));
  assert.match(section.findings[0].evidence, /sk\*{8}/);
});

test("runSecurityInspection does not report a secret reference as a plaintext secret", () => {
  const report = runSecurityInspection({ config: { apiKey: "env:MODEL_API_KEY", password: "file:/etc/secret" } });
  assert.deepEqual(findingIds(report, "plaintext-secret-config"), []);
});

test("runSecurityInspection reports a destructive tool that declares it needs no approval", () => {
  const report = runSecurityInspection({
    toolCatalog: [{ id: "files.delete", risk: "destructive", source: "skill", requiresApproval: false }]
  });
  const ids = findingIds(report, "destructive-tool-without-approval");
  assert.equal(ids.length, 1);
  const finding = report.sections.find(item => item.id === "destructive-tool-without-approval").findings[0];
  assert.equal(finding.severity, "critical");
  assert.match(finding.evidence, /files\.delete/);
});

test("runSecurityInspection reports a destructive tool when the policy drops it from the approval list", () => {
  const report = runSecurityInspection({
    toolCatalog: [{ id: "files.delete", risk: "destructive", source: "builtin" }],
    config: { approvalRequired: ["write"] }
  });
  const ids = findingIds(report, "destructive-tool-without-approval");
  assert.equal(ids.length, 1);
  const finding = report.sections.find(item => item.id === "destructive-tool-without-approval").findings[0];
  assert.match(finding.evidence, /approvalRequired/);
});

test("runSecurityInspection stays quiet when the destructive tools keep their approval", () => {
  const report = runSecurityInspection({ toolCatalog: CATALOG });
  assert.deepEqual(findingIds(report, "destructive-tool-without-approval"), []);
});

test("runSecurityInspection reports an over broad storage root", () => {
  const report = runSecurityInspection({ storageRoots: ["/vol1", "/"] });
  const ids = findingIds(report, "over-broad-file-root");
  assert.equal(ids.length, 1);
  const finding = report.sections.find(item => item.id === "over-broad-file-root").findings[0];
  assert.equal(finding.severity, "critical");
  assert.match(finding.evidence, /storageRoots/);
});

test("runSecurityInspection stays quiet for a normal storage volume", () => {
  const report = runSecurityInspection({ storageRoots: ["/vol1", "/vol2"] });
  assert.deepEqual(findingIds(report, "over-broad-file-root"), []);
});

test("runSecurityInspection reports a failed scheduled check", () => {
  const report = runSecurityInspection({
    scheduledChecks: [
      { id: "check-1", name: "存储巡检", lastStatus: "ok" },
      { id: "check-2", name: "容器巡检", lastStatus: "error" }
    ]
  });
  const ids = findingIds(report, "scheduled-check-failure");
  assert.equal(ids.length, 1);
  const finding = report.sections.find(item => item.id === "scheduled-check-failure").findings[0];
  assert.equal(finding.severity, "warning");
  assert.match(finding.evidence, /check-2/);
});

test("runSecurityInspection reports a repeated audit failure", () => {
  const report = runSecurityInspection({
    auditEntries: [
      { route: "tools.run", outcome: "error", detail: "timeout after 30 seconds" },
      { route: "tools.run", outcome: "error", detail: "timeout after 45 seconds" }
    ]
  });
  const ids = findingIds(report, "repeated-audit-failure");
  assert.equal(ids.length, 1);
  const finding = report.sections.find(item => item.id === "repeated-audit-failure").findings[0];
  assert.equal(finding.severity, "warning");
  assert.match(finding.evidence, /× 2/);
});

test("runSecurityInspection counts the findings by severity", () => {
  const report = runSecurityInspection({
    toolCatalog: [{ id: "files.delete", risk: "destructive", source: "skill", requiresApproval: false }],
    config: { listenAddress: "0.0.0.0", model: { apiKey: "sk-plaintext-secret-value" } },
    storageRoots: ["/"],
    scheduledChecks: [{ id: "check-2", name: "容器巡检", lastStatus: "error" }],
    auditEntries: [
      { route: "tools.run", outcome: "error", detail: "timeout after 30 seconds" },
      { route: "tools.run", outcome: "error", detail: "timeout after 45 seconds" }
    ]
  });
  assert.equal(report.summary.total, 6);
  assert.equal(report.summary.critical, 3);
  assert.equal(report.summary.warning, 3);
  assert.equal(report.summary.info, 0);
});

test("runSecurityInspection gives every finding an id, a severity and a recommendation", () => {
  const report = runSecurityInspection({
    config: { listenAddress: "0.0.0.0", apiKey: "sk-plaintext-secret-value" },
    storageRoots: ["/"]
  });
  for (const section of report.sections) {
    for (const finding of section.findings) {
      assert.ok(finding.id, "a finding carries an id");
      assert.ok(finding.title, "a finding carries a title");
      assert.ok(finding.detail, "a finding carries a detail");
      assert.ok(finding.evidence, "a finding carries evidence");
      assert.ok(finding.recommendation, "a finding carries a recommendation");
      assert.ok(["critical", "warning", "info"].includes(finding.severity));
    }
  }
});

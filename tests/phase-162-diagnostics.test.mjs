import test from "node:test";
import assert from "node:assert/strict";

import {
  DIAGNOSTIC_CATEGORIES,
  DIAGNOSTIC_CONFIDENCE_LEVELS,
  classifyEvidence,
  classifyEvidenceDetail,
  rankCauses,
  buildDiagnosticReport,
  isSafeSuggestion
} from "../apps/fnos-nas-agent/app/diagnostics.mjs";

const STORAGE_EVIDENCE = [
  { source: "smartctl", detail: "SMART overall-health self-assessment failed: FAILED!" },
  { source: "kernel", detail: "ata1: I/O error, dev sda, sector 194560" }
];

const WEAK_STORAGE_EVIDENCE = [{ source: "metric", detail: "disk latency high" }];

const TWO_WEAK_STORAGE_EVIDENCE = [
  { source: "metric", detail: "disk latency high" },
  { source: "metric", detail: "disk queue depth rising" }
];

const DESTRUCTIVE_ACTIONS = [
  "rm -rf /",
  "rm -rf /mnt/data",
  "mkfs.ext4 /dev/sdb1",
  "dd if=/dev/zero of=/dev/sda",
  "mdadm --stop /dev/md0",
  "重建阵列",
  "停止存储服务",
  "systemctl stop storage.service",
  "restart all services",
  "重启所有服务"
];

const DESTRUCTIVE_PATTERN = /(rm\s+-[a-z]*r|rm\s+-rf|mkfs|\bdd\s+(if|of)=|mdadm\s+--stop|重建\s*阵列|停止\s*存储服务|rmdir|shred|fdisk|wipefs|truncate\s+-s\s*0)/i;

test("DIAGNOSTIC_CATEGORIES 暴露约定的五个分类", () => {
  assert.deepEqual([...DIAGNOSTIC_CATEGORIES], [
    "storage",
    "network",
    "resource",
    "permission",
    "application"
  ]);
  assert.deepEqual([...DIAGNOSTIC_CONFIDENCE_LEVELS], ["confirmed", "likely", "suspected"]);
});

test("存储/SMART/阵列/IO 证据归类为 storage", () => {
  assert.equal(classifyEvidence(STORAGE_EVIDENCE), "storage");
  assert.equal(classifyEvidence([{ source: "mdadm", detail: "md0 degraded, member sdb1 failed" }]), "storage");
  assert.equal(classifyEvidence([{ source: "fs", detail: "EXT4-fs error (device sda1)" }]), "storage");
});

test("网络 / 资源 / 权限 / 应用证据分别归类", () => {
  assert.equal(classifyEvidence([{ source: "log", detail: "Could not resolve host nas.local" }]), "network");
  assert.equal(classifyEvidence([{ source: "log", detail: "Out of memory: Killed process 812" }]), "resource");
  assert.equal(classifyEvidence([{ source: "log", detail: "open /etc/app.conf: Permission denied" }]), "permission");
  assert.equal(classifyEvidence([{ source: "docker", detail: "container app exited with code 1" }]), "application");
});

test("无法判定的证据归类为 application 且给出 reason", () => {
  assert.equal(classifyEvidence([]), "application");
  assert.equal(classifyEvidence([{ source: "x", detail: "zzz" }]), "application");
  const detail = classifyEvidenceDetail([]);
  assert.equal(detail.category, "application");
  assert.match(detail.reason, /application/);
});

test("存储类证据产生 confirmed 置信度的根因候选", () => {
  const causes = rankCauses(STORAGE_EVIDENCE);
  assert.ok(causes.length > 0);
  const top = causes[0];
  assert.equal(top.category, "storage");
  assert.equal(top.confidence, "confirmed");
  assert.ok(Array.isArray(top.evidence) && top.evidence.length > 0);
  assert.equal(typeof top.evidence[0].source, "string");
  assert.equal(typeof top.evidence[0].detail, "string");
  assert.ok(Array.isArray(top.checks) && top.checks.length > 0);
  assert.ok(top.checks.every((check) => typeof check === "string"));
});

test("同类证据至少两条时置信度为 likely", () => {
  const causes = rankCauses(TWO_WEAK_STORAGE_EVIDENCE);
  const storageCause = causes.find((cause) => cause.id === "storage-disk-failure");
  assert.ok(storageCause, "应当出现磁盘健康类根因候选");
  assert.equal(storageCause.confidence, "likely");
});

test("仅弱信号时置信度为 suspected", () => {
  const causes = rankCauses(WEAK_STORAGE_EVIDENCE);
  const storageCause = causes.find((cause) => cause.id === "storage-disk-failure");
  assert.ok(storageCause);
  assert.equal(storageCause.confidence, "suspected");
});

test("空证据不得产生 confirmed 置信度", () => {
  const causes = rankCauses([]);
  assert.deepEqual(causes, []);
  for (const cause of causes) {
    assert.notEqual(cause.confidence, "confirmed");
  }
});

test("根因候选受 limit 限制并按置信度排序", () => {
  const causes = rankCauses(STORAGE_EVIDENCE, { limit: 1 });
  assert.equal(causes.length, 1);
  const full = rankCauses(STORAGE_EVIDENCE, { limit: 50 });
  assert.ok(full.length >= 1);
  const ranks = { confirmed: 3, likely: 2, suspected: 1 };
  for (let index = 1; index < full.length; index += 1) {
    assert.ok(ranks[full[index - 1].confidence] >= ranks[full[index].confidence]);
  }
});

test("故障报告包含分类、根因、只读检查与人工升级结论", () => {
  const report = buildDiagnosticReport({
    symptom: "存储卷读写变慢并出现 IO 错误",
    evidence: STORAGE_EVIDENCE,
    now: "2026-10-22T00:00:00.000Z"
  });
  assert.equal(report.symptom, "存储卷读写变慢并出现 IO 错误");
  assert.equal(report.category, "storage");
  assert.equal(typeof report.summary, "string");
  assert.ok(report.causes.length > 0);
  assert.ok(report.readOnlyChecks.length > 0);
  assert.ok(Array.isArray(report.nextSteps));
  assert.equal(typeof report.escalation.required, "boolean");
  assert.equal(typeof report.escalation.reason, "string");
  assert.match(report.report, /故障诊断报告/);
  assert.match(report.report, /根因候选/);
  assert.match(report.report, /置信度/);
});

test("nextSteps 不包含删除 / 重建 / 格式化类破坏性动作", () => {
  const scenarios = [
    { symptom: "磁盘异常", evidence: STORAGE_EVIDENCE },
    { symptom: "服务反复退出", evidence: [{ source: "docker", detail: "container app exited with code 1" }] },
    { symptom: "网络不通", evidence: [{ source: "log", detail: "Network is unreachable" }] },
    { symptom: "内存不足", evidence: [{ source: "log", detail: "Out of memory: Killed process 812" }] },
    { symptom: "权限被拒", evidence: [{ source: "log", detail: "open /etc/app.conf: Permission denied" }] }
  ];
  for (const scenario of scenarios) {
    const report = buildDiagnosticReport(scenario);
    for (const step of report.nextSteps) {
      assert.ok(
        !DESTRUCTIVE_PATTERN.test(step),
        `nextSteps 不得包含破坏性动作：${step}`
      );
      assert.ok(isSafeSuggestion(step), `nextSteps 必须是安全建议：${step}`);
    }
  }
});

test("只读诊断项不包含写操作", () => {
  const report = buildDiagnosticReport({ symptom: "阵列降级", evidence: STORAGE_EVIDENCE });
  for (const check of report.readOnlyChecks) {
    assert.ok(isSafeSuggestion(check), `只读检查项必须安全：${check}`);
    assert.ok(!/\b(mkfs|rm -|dd if=|wipefs|fdisk)\b/i.test(check));
  }
});

test("isSafeSuggestion 明确拒绝扩大损失的动作", () => {
  for (const action of DESTRUCTIVE_ACTIONS) {
    assert.equal(isSafeSuggestion(action), false, `应当拒绝：${action}`);
  }
  assert.equal(isSafeSuggestion("smartctl -a /dev/sda"), true);
  assert.equal(isSafeSuggestion("cat /proc/mdstat"), true);
  assert.equal(isSafeSuggestion("查看服务近期日志"), true);
  assert.equal(isSafeSuggestion(""), false);
  assert.equal(isSafeSuggestion(null), false);
});

test("存储类故障会标记需要人工审批而不是自动执行", () => {
  const report = buildDiagnosticReport({
    symptom: "阵列降级",
    evidence: [{ source: "mdadm", detail: "md0 degraded, member sdb1 failed" }]
  });
  assert.equal(report.escalation.required, true);
  assert.ok(report.escalation.reason.length > 0);
});

test("空证据时报告保持可用并说明缺少证据", () => {
  const report = buildDiagnosticReport({ symptom: "偶发异常" });
  assert.equal(report.category, "application");
  assert.deepEqual(report.causes, []);
  assert.equal(report.escalation.required, true);
  assert.match(report.summary, /证据/);
});

test("显式传入 causes 时报告沿用调用方排序", () => {
  const report = buildDiagnosticReport({
    symptom: "自定义",
    causes: [
      {
        id: "custom-cause",
        title: "自定义根因",
        category: "network",
        confidence: "likely",
        evidence: [{ source: "s", detail: "d" }],
        checks: ["查看接口状态"]
      }
    ]
  });
  assert.equal(report.causes.length, 1);
  assert.equal(report.causes[0].id, "custom-cause");
  assert.equal(report.category, "network");
});

test("模块是纯函数：无 I/O、无模型调用、无第三方依赖", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../apps/fnos-nas-agent/app/diagnostics.mjs", import.meta.url), "utf8")
  );
  assert.ok(!/from\s+["'][^./]/.test(source), "不得引入第三方包");
  assert.ok(!/node:fs|node:net|node:http|fetch\(|child_process/.test(source), "不得做任何 I/O");
  assert.ok(!/openai|anthropic|llm|model\.call/i.test(source), "不得调用模型");
});

test("相同输入产生相同输出（确定性）", () => {
  const first = buildDiagnosticReport({ symptom: "确定性", evidence: STORAGE_EVIDENCE, now: "2026-01-01T00:00:00Z" });
  const second = buildDiagnosticReport({ symptom: "确定性", evidence: STORAGE_EVIDENCE, now: "2026-01-01T00:00:00Z" });
  assert.deepEqual(first, second);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

import {
  BACKUP_CHECK_IDS,
  BACKUP_PRECHECK_DEFAULTS,
  buildBackupPrecheck,
  readStorageEntries
} from "../apps/fnos-nas-agent/app/backup-precheck.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "../apps/fnos-nas-agent/app");

function read(relative) {
  return readFileSync(resolve(app, relative), "utf8");
}

function snapshotWithStorage(values) {
  return { generatedAt: "2026-10-24T00:00:00.000Z", sections: [{ id: "storage", title: "存储", status: "ok", values }] };
}

test("没有任何数据时全部检查项都是 unknown，整体判定 unknown", () => {
  const report = buildBackupPrecheck({});
  assert.equal(report.checks.length, BACKUP_CHECK_IDS.length);
  for (const item of report.checks) assert.equal(item.status, "unknown", `${item.id} 应为 unknown`);
  assert.equal(report.summary.unknown, BACKUP_CHECK_IDS.length);
  assert.equal(report.verdict, "unknown");
  assert.ok(report.actions.some(action => action.includes("补采")));
});

test("readStorageEntries 兼容 disks 与 volumes 两种来源", () => {
  const entries = readStorageEntries(snapshotWithStorage({
    disks: [{ name: "sda", totalBytes: 1000, usedBytes: 500, readOnly: false }],
    volumes: [{ mount: "/vol1", totalBytes: 2000, usedBytes: 200 }]
  }));
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(entry => entry.source), ["disk", "volume"]);
  assert.equal(entries[1].name, "/vol1");
});

test("空间充裕、服务正常、SMART 正常时判定 ready", () => {
  const report = buildBackupPrecheck({
    snapshot: snapshotWithStorage({ disks: [{ name: "vol1", totalBytes: 1000, usedBytes: 100, readOnly: false }] }),
    capacity: { trends: [{ name: "vol1", daysToFull: 300 }] },
    services: { units: [{ name: "filestor_service", activeState: "running" }] },
    smart: { devices: [{ device: "/dev/sda", health: "ok" }] },
    diagnostics: { findings: [{ severity: "info" }], escalation: { required: false } }
  });
  assert.equal(report.verdict, "ready");
  assert.equal(report.summary.blocked, 0);
  assert.equal(report.summary.warn, 0);
  assert.equal(report.summary.ok, BACKUP_CHECK_IDS.length);
});

test("可用空间见底时 blocked，并给出处理动作", () => {
  const report = buildBackupPrecheck({
    snapshot: snapshotWithStorage({ disks: [{ name: "vol4", totalBytes: 1000, usedBytes: 970, readOnly: false }] })
  });
  assert.equal(report.verdict, "blocked");
  const free = report.checks.find(item => item.id === "free-space");
  assert.equal(free.status, "blocked");
  assert.ok(free.detail.includes("vol4"));
  assert.ok(report.actions[0].includes("可用空间"));
});

test("可用空间偏紧但未见底时 warn", () => {
  const report = buildBackupPrecheck({
    snapshot: snapshotWithStorage({ disks: [{ name: "vol1", totalBytes: 1000, usedBytes: 880 }] })
  });
  const free = report.checks.find(item => item.id === "free-space");
  assert.equal(free.status, "warn");
});

test("只读挂载会被判成 blocked", () => {
  const report = buildBackupPrecheck({
    snapshot: snapshotWithStorage({ volumes: [{ mount: "/vol4", totalBytes: 1000, usedBytes: 100, readOnly: true }] })
  });
  const readOnly = report.checks.find(item => item.id === "read-only-volumes");
  assert.equal(readOnly.status, "blocked");
  assert.ok(readOnly.detail.includes("/vol4"));
});

test("容量趋势临近写满时按阈值降级", () => {
  const base = {
    snapshot: snapshotWithStorage({ disks: [{ name: "vol2", totalBytes: 1000, usedBytes: 100 }] })
  };
  const warn = buildBackupPrecheck({ ...base, capacity: { trends: [{ name: "vol2", daysToFull: 20 }] } });
  assert.equal(warn.checks.find(item => item.id === "capacity-trend").status, "warn");
  const blocked = buildBackupPrecheck({ ...base, capacity: { trends: [{ name: "vol2", daysToFull: 3 }] } });
  assert.equal(blocked.checks.find(item => item.id === "capacity-trend").status, "blocked");
  const ok = buildBackupPrecheck({ ...base, capacity: { trends: [{ name: "vol2", daysToFull: 200 }] } });
  assert.equal(ok.checks.find(item => item.id === "capacity-trend").status, "ok");
});

test("阈值可以被调用方覆盖，且越界值会被夹回合理区间", () => {
  const report = buildBackupPrecheck(
    { snapshot: snapshotWithStorage({ disks: [{ name: "vol1", totalBytes: 1000, usedBytes: 540 }] }) },
    { warnFreeRatio: 0.5, blockFreeRatio: 0.4 }
  );
  assert.equal(report.thresholds.warnFreeRatio, 0.5);
  assert.equal(report.checks.find(item => item.id === "free-space").status, "warn");

  const clamped = buildBackupPrecheck({}, { warnFreeRatio: 5, blockFreeRatio: -1, warnDaysToFull: 0 });
  assert.equal(clamped.thresholds.warnFreeRatio, 0.9);
  assert.equal(clamped.thresholds.blockFreeRatio, 0.01);
  assert.equal(clamped.thresholds.warnDaysToFull, 1);
});

test("核心服务失败与普通服务失败都只降级为 warn", () => {
  const core = buildBackupPrecheck({
    snapshot: snapshotWithStorage({ disks: [{ name: "vol1", totalBytes: 1000, usedBytes: 100 }] }),
    services: { units: [{ name: "filestor_service", activeState: "failed" }] }
  });
  const coreCheck = core.checks.find(item => item.id === "failed-units");
  assert.equal(coreCheck.status, "warn");
  assert.ok(coreCheck.detail.includes("filestor_service"));

  const other = buildBackupPrecheck({
    snapshot: snapshotWithStorage({ disks: [{ name: "vol1", totalBytes: 1000, usedBytes: 100 }] }),
    services: { units: [{ name: "smbftpd", state: "failed" }, { name: "cron", state: "running" }] }
  });
  assert.equal(other.checks.find(item => item.id === "failed-units").status, "warn");
});

test("SMART 报失效时 blocked，报预警时 warn", () => {
  const failing = buildBackupPrecheck({
    snapshot: snapshotWithStorage({ disks: [{ name: "vol1", totalBytes: 1000, usedBytes: 100 }] }),
    smart: { devices: [{ device: "/dev/sdb", health: "failing" }] }
  });
  assert.equal(failing.checks.find(item => item.id === "smart-health").status, "blocked");
  assert.equal(failing.verdict, "blocked");

  const warning = buildBackupPrecheck({
    snapshot: snapshotWithStorage({ disks: [{ name: "vol1", totalBytes: 1000, usedBytes: 100 }] }),
    smart: { devices: [{ device: "/dev/sdc", health: "warning" }] }
  });
  assert.equal(warning.checks.find(item => item.id === "smart-health").status, "warn");
});

test("诊断要求升级时列出原因，严重结论降级为 warn", () => {
  const escalation = buildBackupPrecheck({
    snapshot: snapshotWithStorage({ disks: [{ name: "vol1", totalBytes: 1000, usedBytes: 100 }] }),
    diagnostics: { findings: [{ severity: "warning" }], escalation: { required: true, reasons: [{ detail: "磁盘重分配扇区增长" }] } }
  });
  const checkItem = escalation.checks.find(item => item.id === "diagnostics");
  assert.equal(checkItem.status, "warn");
  assert.ok(checkItem.detail.includes("磁盘重分配扇区增长"));

  const critical = buildBackupPrecheck({
    snapshot: snapshotWithStorage({ disks: [{ name: "vol1", totalBytes: 1000, usedBytes: 100 }] }),
    diagnostics: { findings: [{ severity: "critical" }, { severity: "info" }] }
  });
  assert.equal(critical.checks.find(item => item.id === "diagnostics").status, "warn");
});

test("默认阈值常量保持保守取值", () => {
  assert.deepEqual(BACKUP_PRECHECK_DEFAULTS, {
    warnFreeRatio: 0.15,
    blockFreeRatio: 0.05,
    warnDaysToFull: 30,
    blockDaysToFull: 7
  });
});

test("服务端把体检路由挂到会话鉴权之后，并登记审计名", () => {
  const server = read("server.mjs");
  assert.ok(server.includes('import { buildBackupPrecheck } from "./backup-precheck.mjs";'), "必须导入体检模块");
  const route = server.slice(server.indexOf('if (url.pathname === "/api/backup/precheck") {'));
  const guarded = route.slice(0, 400);
  assert.ok(guarded.includes('if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });'), "必须先鉴权");
  assert.ok(guarded.includes("req.method !== \"GET\""), "体检必须是只读 GET");
  assert.ok(server.includes('if (pathname === "/api/backup/precheck") return "backup.precheck";'), "审计名要登记");
  assert.ok(server.includes("buildBackupPrecheck({ snapshot, capacity: { trends }, services, smart }"), "报告必须由纯函数生成");
});

test("体检页有入口按钮，并把结论渲染成可读清单", () => {
  const html = read("ui/index.html");
  assert.ok(html.includes('id="ops-backup-precheck"'), "要有运行按钮");
  assert.ok(html.includes('id="ops-backup-result"'), "要有结果容器");
  const pages = read("ui/pages.js");
  assert.ok(pages.includes('guard("#ops-backup-precheck","备份前检查",runOpsBackupPrecheck);'), "按钮必须绑定处理函数");
  assert.ok(pages.includes('const result=await opsFetch("/api/backup/precheck");'), "必须调用只读体检接口");
  assert.ok(pages.includes("BACKUP_VERDICT_LABELS"), "结论要有中文文案");
  assert.ok(pages.includes("BACKUP_STATUS_LABELS"), "检查项状态要有中文文案");
  assert.ok(pages.includes("opsSection(\"#ops-backup-result\"") || pages.includes("opsSection('#ops-backup-result'") || pages.includes('opsSection("#ops-backup-result"'), "结果要落到指定容器");
});

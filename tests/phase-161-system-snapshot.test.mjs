import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  buildSystemSnapshot,
  scoreHealth,
  mergeSectionValues,
  describeSectionStatus,
  DEFAULT_SECTIONS,
  UNCOVERED_SIDS
} from "../apps/fnos-nas-agent/app/system-snapshot.mjs";

const FIXED_NOW = () => Date.parse("2026-10-22T12:00:00.000Z");

function okCollector(overrides = {}) {
  return async (id) => {
    if (Object.prototype.hasOwnProperty.call(overrides, id)) {
      const value = overrides[id];
      if (value instanceof Error) throw value;
      return value;
    }
    switch (id) {
      case "cpu":
        return { status: "ok", values: { usagePercent: 20, temperatureC: 45 } };
      case "memory":
        return { status: "ok", values: { usedPercent: 35, totalBytes: 1000, availableBytes: 650 } };
      case "storage":
        return {
          status: "ok",
          values: {
            disks: [
              { name: "sda", totalBytes: 1000, usedBytes: 200, smart: { supported: true, status: "ok" } }
            ]
          }
        };
      case "network":
        return { status: "ok", values: { online: true, latencyMs: 20 } };
      case "services":
        return { status: "ok", values: { total: 20, failed: 0 } };
      case "docker":
        return { status: "ok", values: { available: true, containersTotal: 5, containersRunning: 5 } };
      default:
        return { status: "unknown", note: "未实现" };
    }
  };
}

test("buildSystemSnapshot exposes the six fixed default sections", async () => {
  const snapshot = await buildSystemSnapshot({ collect: okCollector(), now: FIXED_NOW });
  assert.deepEqual(
    snapshot.sections.map(section => section.id),
    ["cpu", "memory", "storage", "network", "services", "docker"]
  );
  assert.equal(snapshot.generatedAt, "2026-10-22T12:00:00.000Z");
  assert.equal(typeof snapshot.score.value, "number");
  assert.ok(Array.isArray(snapshot.score.breakdown));
});

test("default sections record the S-numbers of module 02 they answer", () => {
  const covered = DEFAULT_SECTIONS.flatMap(section => section.sIds);
  assert.deepEqual(covered, ["S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10", "S11", "S12"]);
  assert.deepEqual(
    UNCOVERED_SIDS.map(item => item.id),
    ["S13", "S14", "S15"]
  );
  assert.ok(UNCOVERED_SIDS.every(item => item.note.includes("未采集")));
});

test("a healthy system scores good when every section is collected", async () => {
  const snapshot = await buildSystemSnapshot({ collect: okCollector(), now: FIXED_NOW });
  assert.equal(snapshot.score.grade, "good");
  assert.ok(snapshot.score.value >= 80, `expected >= 80, got ${snapshot.score.value}`);
  assert.equal(snapshot.score.breakdown.length, 6);
  assert.ok(snapshot.score.breakdown.every(entry => typeof entry.score === "number"));
});

test("a failing collector never produces normal looking values", async () => {
  const snapshot = await buildSystemSnapshot({
    collect: async () => {
      throw new Error("采集接口超时");
    },
    now: FIXED_NOW
  });
  assert.ok(snapshot.sections.every(section => section.status === "unavailable"));
  assert.ok(snapshot.sections.every(section => Object.keys(section.values).length === 0));
  assert.equal(snapshot.score.grade, "unknown");
  assert.equal(snapshot.score.value, 0);
  assert.ok(snapshot.score.breakdown.every(entry => entry.score === null));
});

test("a section without data stays unknown instead of being filled with defaults", async () => {
  const snapshot = await buildSystemSnapshot({
    collect: okCollector({ storage: { status: "unknown" } }),
    now: FIXED_NOW
  });
  const storage = snapshot.sections.find(section => section.id === "storage");
  assert.equal(storage.status, "unknown");
  assert.deepEqual(storage.values, {});
  assert.equal(storage.note, "数据未采集");
});

test("a collector reporting ok without usable data is downgraded to unknown", async () => {
  const snapshot = await buildSystemSnapshot({
    collect: okCollector({ cpu: { status: "ok", values: {} } }),
    now: FIXED_NOW
  });
  const cpu = snapshot.sections.find(section => section.id === "cpu");
  assert.equal(cpu.status, "unknown");
  assert.deepEqual(cpu.values, {});
  assert.equal(cpu.note, "采集接口未返回可用数据");
});

test("an unknown status does not contribute to the weighted score", async () => {
  const snapshot = await buildSystemSnapshot({
    collect: okCollector({ docker: { status: "unknown" } }),
    now: FIXED_NOW
  });
  const docker = snapshot.sections.find(section => section.id === "docker");
  assert.equal(docker.status, "unknown");
  const entry = snapshot.score.breakdown.find(item => item.id === "docker");
  assert.equal(entry.score, null);
  assert.ok(entry.reason.includes("数据未采集"));
  assert.ok(snapshot.score.value < 100);
});

test("all sections unknown results in grade unknown", () => {
  const sections = DEFAULT_SECTIONS.map(section => ({
    id: section.id,
    title: section.title,
    status: "unknown",
    values: {},
    note: "数据未采集"
  }));
  const score = scoreHealth(sections);
  assert.equal(score.grade, "unknown");
  assert.equal(score.value, 0);
  assert.equal(score.coverage, 0);
  assert.ok(score.breakdown.every(entry => entry.score === null));
});

test("all sections unavailable results in grade unknown", () => {
  const sections = DEFAULT_SECTIONS.map(section => ({
    id: section.id,
    title: section.title,
    status: "unavailable",
    values: {},
    note: "接口不可用"
  }));
  const score = scoreHealth(sections);
  assert.equal(score.grade, "unknown");
  assert.equal(score.value, 0);
});

test("the value reflects the share of collected data", async () => {
  const full = await buildSystemSnapshot({ collect: okCollector(), now: FIXED_NOW });
  const partial = await buildSystemSnapshot({
    collect: okCollector({ storage: { status: "unknown" }, docker: { status: "unknown" } }),
    now: FIXED_NOW
  });
  assert.ok(partial.score.value < full.score.value);
  assert.ok(partial.score.coverage < 1);
});

test("an explicit weight override changes the weighted result", () => {
  const sections = [
    { id: "cpu", status: "ok", values: { usagePercent: 95 } },
    { id: "memory", status: "ok", values: { usedPercent: 10 } }
  ];
  const balanced = scoreHealth(sections);
  const cpuHeavy = scoreHealth(sections, { weights: { cpu: 9, memory: 1 } });
  assert.ok(cpuHeavy.value < balanced.value);
  assert.equal(balanced.breakdown.length, 2);
});

test("a low coverage is graded unknown because the score is not trustworthy", () => {
  const sections = [
    { id: "cpu", status: "ok", values: { usagePercent: 5 } },
    { id: "memory", status: "unknown", values: {} },
    { id: "storage", status: "unknown", values: {} },
    { id: "network", status: "unknown", values: {} },
    { id: "services", status: "unknown", values: {} },
    { id: "docker", status: "unknown", values: {} }
  ];
  const score = scoreHealth(sections);
  assert.equal(score.grade, "unknown");
  assert.ok(score.coverage < 0.34);
});

test("a full disk lowers the storage score", async () => {
  const snapshot = await buildSystemSnapshot({
    collect: okCollector({
      storage: {
        status: "ok",
        values: {
          disks: [{ name: "sda", totalBytes: 1000, usedBytes: 990, smart: { supported: true, status: "ok" } }]
        }
      }
    }),
    now: FIXED_NOW
  });
  const storage = snapshot.sections.find(section => section.id === "storage");
  assert.equal(storage.status, "ok");
  const entry = snapshot.score.breakdown.find(item => item.id === "storage");
  assert.ok(entry.score < 50, `expected a low storage score, got ${entry.score}`);
});

test("a failing SMART disk is reported and caps the storage score", async () => {
  const snapshot = await buildSystemSnapshot({
    collect: okCollector({
      storage: {
        status: "ok",
        values: {
          disks: [{ name: "sdb", totalBytes: 1000, usedBytes: 100, smart: { supported: true, status: "failed" } }]
        }
      }
    }),
    now: FIXED_NOW
  });
  const entry = snapshot.score.breakdown.find(item => item.id === "storage");
  assert.ok(entry.reason.includes("SMART"));
  assert.ok(entry.score <= 20);
});

test("a disk without SMART support is reported as unknown health, not as healthy", async () => {
  const snapshot = await buildSystemSnapshot({
    collect: okCollector({
      storage: {
        status: "ok",
        values: {
          disks: [{ name: "sdc", totalBytes: 1000, usedBytes: 100, smart: { supported: false } }]
        }
      }
    }),
    now: FIXED_NOW
  });
  const entry = snapshot.score.breakdown.find(item => item.id === "storage");
  assert.ok(entry.reason.includes("未知"));
  assert.ok(entry.reason.includes("未采集"));
  assert.ok(entry.reason.includes("SMART"));
});

test("disk capacity without a total size yields an unknown storage section", async () => {
  const snapshot = await buildSystemSnapshot({
    collect: okCollector({ storage: { status: "ok", values: { disks: [{ name: "sdd" }] } } }),
    now: FIXED_NOW
  });
  const storage = snapshot.sections.find(section => section.id === "storage");
  assert.equal(storage.status, "unknown");
  assert.deepEqual(storage.values, {});
});

test("mergeSectionValues merges section values with the later payload winning", () => {
  const older = [
    { id: "cpu", status: "ok", values: { usagePercent: 10, model: "x86" } },
    { id: "memory", status: "ok", values: { usedPercent: 20 } }
  ];
  const newer = [{ id: "cpu", status: "ok", values: { usagePercent: 77 } }];
  const merged = mergeSectionValues(older, newer);
  const cpu = merged.find(section => section.id === "cpu");
  assert.equal(cpu.values.usagePercent, 77);
  assert.equal(cpu.values.model, "x86");
  assert.equal(merged.length, 2);
  assert.equal(merged.find(section => section.id === "memory").values.usedPercent, 20);
});

test("mergeSectionValues accepts a single section object", () => {
  const merged = mergeSectionValues(
    { id: "cpu", status: "ok", values: { usagePercent: 10 } },
    { id: "cpu", status: "ok", values: { temperatureC: 50 } }
  );
  assert.equal(merged.values.usagePercent, 10);
  assert.equal(merged.values.temperatureC, 50);
});

test("mergeSectionValues keeps a known status over an unknown one", () => {
  const merged = mergeSectionValues(
    { id: "cpu", status: "ok", values: { usagePercent: 10 } },
    { id: "cpu", status: "unknown", values: {} }
  );
  assert.equal(merged.status, "ok");
  assert.equal(merged.values.usagePercent, 10);
});

test("describeSectionStatus returns the Chinese labels", () => {
  assert.equal(describeSectionStatus("ok"), "正常");
  assert.equal(describeSectionStatus("unknown"), "未采集");
  assert.equal(describeSectionStatus("unavailable"), "接口不可用");
  assert.equal(describeSectionStatus("bogus"), "未采集");
});

test("the snapshot reports the S-numbers that are not collected in this phase", async () => {
  const snapshot = await buildSystemSnapshot({ collect: okCollector(), now: FIXED_NOW });
  assert.deepEqual(
    snapshot.uncovered.map(item => item.id),
    ["S13", "S14", "S15"]
  );
  assert.ok(snapshot.uncovered.every(item => item.note.includes("未采集")));
});

test("the module performs no I/O on its own and never throws", async () => {
  const snapshot = await buildSystemSnapshot({ now: FIXED_NOW });
  assert.ok(snapshot.sections.every(section => section.status === "unknown"));
  assert.equal(snapshot.score.grade, "unknown");
});

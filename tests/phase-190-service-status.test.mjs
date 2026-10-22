import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  COLLECT_NOTES,
  INVALID_UNIT_REASONS,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_UNITS,
  MAX_UNIT_NAME_LENGTH,
  UNIT_SUFFIXES,
  VERDICTS,
  collectServiceStatus,
  describeServiceVerdict,
  parseSystemctlShow,
  summarizeServices,
  validateUnitName
} from "../apps/fnos-nas-agent/app/service-status.mjs";

const MODULE_PATH = new URL("../apps/fnos-nas-agent/app/service-status.mjs", import.meta.url);

/** 一段接近真机的 `systemctl show` 输出（CRLF，验证换行处理）。 */
const SHOW_RUNNING = [
  "LoadState=loaded",
  "ActiveState=active",
  "SubState=running",
  "UnitFileState=enabled",
  "MainPID=1234",
  "MemoryCurrent=52428800",
  "NRestarts=2",
  "Result=success",
  ""
].join("\r\n");

function showText(overrides = {}) {
  const fields = {
    LoadState: "loaded",
    ActiveState: "active",
    SubState: "running",
    UnitFileState: "enabled",
    MainPID: "4321",
    MemoryCurrent: "1048576",
    NRestarts: "0",
    Result: "success",
    ...overrides
  };
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// validateUnitName
// ---------------------------------------------------------------------------

test("validateUnitName accepts the four supported unit suffixes and typical fnOS-style names", () => {
  for (const name of [
    "trim-service.service",
    "docker.socket",
    "fpk-update.timer",
    "mnt-data.mount",
    "user@1000.service",
    "snapper:cleanup.service",
    "a.service"
  ]) {
    assert.deepEqual(validateUnitName(name), { ok: true, reason: null }, `expected ${name} to be valid`);
  }
  assert.deepEqual(UNIT_SUFFIXES, ["service", "timer", "socket", "mount"]);
});

test("validateUnitName reports empty for null/undefined, empty and whitespace-only input", () => {
  for (const value of [undefined, null, "", "   ", "\t\n"]) {
    assert.deepEqual(validateUnitName(value), { ok: false, reason: INVALID_UNIT_REASONS.EMPTY });
  }
});

test("validateUnitName rejects over-long names at exactly 257 characters", () => {
  const suffix = ".service";
  const exact = "a".repeat(MAX_UNIT_NAME_LENGTH - suffix.length) + suffix;
  assert.equal(exact.length, MAX_UNIT_NAME_LENGTH);
  assert.deepEqual(validateUnitName(exact), { ok: true, reason: null });

  const tooLong = "a".repeat(MAX_UNIT_NAME_LENGTH + 1 - suffix.length) + suffix;
  assert.equal(tooLong.length, MAX_UNIT_NAME_LENGTH + 1);
  assert.equal(tooLong.length, 257);
  assert.deepEqual(validateUnitName(tooLong), { ok: false, reason: INVALID_UNIT_REASONS.TOO_LONG });
  assert.equal(MAX_UNIT_NAME_LENGTH, 256);
});

test("validateUnitName rejects unknown or malformed suffixes", () => {
  for (const name of ["trim-service", "trim-service.servicex", "trim-service.Service", "trim.service.timer.bak", "a."]) {
    assert.deepEqual(
      validateUnitName(name),
      { ok: false, reason: INVALID_UNIT_REASONS.BAD_SUFFIX },
      `expected ${name} to fail on suffix`
    );
  }
});

test("validateUnitName rejects shell metacharacters, path traversal and backticks as forbidden-char", () => {
  for (const name of [
    "trim service.service",
    " trim-service.service",
    "trim-service.service ",
    "../../etc/passwd.service",
    "/usr/lib/systemd/system/trim.service",
    "trim`id`.service",
    "trim$(id).service",
    "trim;rm -rf /.service",
    "trim|cat.service",
    "trim&cat.service",
    "trim>out.service",
    "trim<in.service",
    "trim\\x.service",
    "trim'service.service"
  ]) {
    assert.deepEqual(
      validateUnitName(name),
      { ok: false, reason: INVALID_UNIT_REASONS.FORBIDDEN_CHAR },
      `expected ${name} to be rejected as forbidden-char`
    );
  }
});

test("validateUnitName rejects wrong shapes and non-string scalars", () => {
  for (const name of ["-trim.service", ".service", "@trim.service", "_trim.service"]) {
    assert.deepEqual(validateUnitName(name), { ok: false, reason: INVALID_UNIT_REASONS.BAD_SHAPE });
  }
  assert.deepEqual(validateUnitName(42), { ok: false, reason: INVALID_UNIT_REASONS.BAD_SHAPE });
  assert.deepEqual(validateUnitName({ unit: "trim.service" }), { ok: false, reason: INVALID_UNIT_REASONS.BAD_SHAPE });
});

// ---------------------------------------------------------------------------
// parseSystemctlShow
// ---------------------------------------------------------------------------

test("parseSystemctlShow maps every contract field and parses numbers", () => {
  const parsed = parseSystemctlShow(SHOW_RUNNING);
  assert.deepEqual(parsed, {
    loadState: "loaded",
    activeState: "active",
    subState: "running",
    unitFileState: "enabled",
    mainPID: 1234,
    memoryCurrentBytes: 52428800,
    restartCount: 2,
    result: "success",
    parsed: true
  });
});

test("parseSystemctlShow turns [not set] and empty values into null", () => {
  const parsed = parseSystemctlShow(showText({
    UnitFileState: "[not set]",
    MainPID: "[not set]",
    MemoryCurrent: "[not set]",
    NRestarts: "",
    Result: "[not set]"
  }));
  assert.equal(parsed.parsed, true);
  assert.equal(parsed.unitFileState, null);
  assert.equal(parsed.mainPID, null);
  assert.equal(parsed.memoryCurrentBytes, null);
  assert.equal(parsed.restartCount, null);
  assert.equal(parsed.result, null);
  assert.equal(parsed.loadState, "loaded");
});

test("parseSystemctlShow treats the MemoryCurrent unlimited sentinel and unsafe integers as null", () => {
  const sentinel = parseSystemctlShow("MemoryCurrent=18446744073709551615\n");
  assert.equal(sentinel.memoryCurrentBytes, null);
  assert.equal(sentinel.parsed, true);

  const oneLess = parseSystemctlShow("MemoryCurrent=18446744073709551614\n");
  assert.equal(oneLess.memoryCurrentBytes, null);

  const negative = parseSystemctlShow("MemoryCurrent=-1\nMainPID=-1\nNRestarts=abc\n");
  assert.equal(negative.memoryCurrentBytes, null);
  assert.equal(negative.mainPID, null);
  assert.equal(negative.restartCount, null);

  const zero = parseSystemctlShow("MainPID=0\nMemoryCurrent=0\nNRestarts=0\n");
  assert.equal(zero.mainPID, 0);
  assert.equal(zero.memoryCurrentBytes, 0);
  assert.equal(zero.restartCount, 0);
});

test("parseSystemctlShow returns all-null with parsed false for empty or non-text input", () => {
  const emptyFields = {
    loadState: null,
    activeState: null,
    subState: null,
    unitFileState: null,
    mainPID: null,
    memoryCurrentBytes: null,
    restartCount: null,
    result: null
  };
  for (const value of [undefined, null, 0, 42, {}, [], "", "   \n\t"]) {
    assert.deepEqual(parseSystemctlShow(value), { ...emptyFields, parsed: false });
  }
  // 没有任何 Key=Value 行的文本也解析不出东西，不能谎报 parsed:true。
  assert.deepEqual(parseSystemctlShow("systemctl: unit not found"), { ...emptyFields, parsed: false });
});

test("parseSystemctlShow keeps the last value when a key repeats and ignores unknown keys", () => {
  const parsed = parseSystemctlShow("ActiveState=inactive\nDescription=with = signs\nActiveState=failed\n");
  assert.equal(parsed.activeState, "failed");
  assert.equal(parsed.parsed, true);
});

// ---------------------------------------------------------------------------
// describeServiceVerdict
// ---------------------------------------------------------------------------

test("describeServiceVerdict returns running only for active + running/exited/listening", () => {
  for (const subState of ["running", "exited", "listening"]) {
    assert.equal(describeServiceVerdict({ activeState: "active", subState }), VERDICTS.RUNNING);
  }
  // active 但不是已知的「在跑」子状态 → unknown，绝不默认 running。
  assert.equal(describeServiceVerdict({ activeState: "active", subState: "start" }), VERDICTS.UNKNOWN);
  assert.equal(describeServiceVerdict({ activeState: "active" }), VERDICTS.UNKNOWN);
  assert.equal(describeServiceVerdict({ activeState: "active", subState: null }), VERDICTS.UNKNOWN);
});

test("describeServiceVerdict returns failed for failed state or failed result", () => {
  assert.equal(describeServiceVerdict({ activeState: "failed", subState: "failed" }), VERDICTS.FAILED);
  assert.equal(describeServiceVerdict({ activeState: "inactive", result: "failed" }), VERDICTS.FAILED);
  assert.equal(describeServiceVerdict({ result: "failed" }), VERDICTS.FAILED);
  assert.equal(describeServiceVerdict({ activeState: "failed" }), VERDICTS.FAILED);
});

test("describeServiceVerdict returns stopped only for inactive/dead and unknown for transitional states", () => {
  assert.equal(describeServiceVerdict({ activeState: "inactive", subState: "dead" }), VERDICTS.STOPPED);
  assert.equal(describeServiceVerdict({ activeState: "dead", subState: "dead" }), VERDICTS.STOPPED);
  for (const activeState of ["activating", "deactivating", "reloading", "maintenance", "unknown", "", "Active"]) {
    assert.equal(describeServiceVerdict({ activeState, subState: "start" }), VERDICTS.UNKNOWN);
  }
});

test("describeServiceVerdict never guesses: null, empty and missing records are unknown", () => {
  for (const record of [null, undefined, {}, [], 0, "", { subState: "running" }, { activeState: null }]) {
    assert.equal(describeServiceVerdict(record), VERDICTS.UNKNOWN, `expected ${JSON.stringify(record)} to be unknown`);
  }
});

// ---------------------------------------------------------------------------
// summarizeServices
// ---------------------------------------------------------------------------

test("summarizeServices returns zero counts and unknown for an empty list", () => {
  const summary = summarizeServices([]);
  assert.deepEqual(summary.counts, { running: 0, stopped: 0, failed: 0, unknown: 0 });
  assert.deepEqual(summary.items, []);
  assert.equal(summary.verdict, "unknown");
  assert.deepEqual(summary.notes, ["no-services"]);
});

test("summarizeServices degrades when any record failed and names it in notes", () => {
  const summary = summarizeServices([
    { unit: "trim-service.service", activeState: "active", subState: "running" },
    { unit: "docker.socket", activeState: "failed", subState: "failed" }
  ]);
  assert.equal(summary.verdict, "degraded");
  assert.deepEqual(summary.counts, { running: 1, stopped: 0, failed: 1, unknown: 0 });
  assert.deepEqual(summary.items, [
    { id: "trim-service.service", unit: "trim-service.service", verdict: "running", activeState: "active", subState: "running" },
    { id: "docker.socket", unit: "docker.socket", verdict: "failed", activeState: "failed", subState: "failed" }
  ]);
  assert.ok(summary.notes.includes("failed: docker.socket"), summary.notes.join(" | "));
});

test("summarizeServices reports unknown for all-unknown input and notes missing units", () => {
  const summary = summarizeServices([
    { id: "probe-1" },
    { unit: "mystery.service", activeState: "activating", subState: "start" }
  ]);
  assert.equal(summary.verdict, "unknown");
  assert.deepEqual(summary.counts, { running: 0, stopped: 0, failed: 0, unknown: 2 });
  assert.ok(summary.notes.includes("unknown-verdict: probe-1, mystery.service"), summary.notes.join(" | "));
  assert.ok(summary.notes.includes("missing-unit: probe-1"), summary.notes.join(" | "));
  assert.deepEqual(summary.items[0], { id: "probe-1", unit: null, verdict: "unknown", activeState: null, subState: null });
});

test("summarizeServices is healthy for running+stopped mixes and keeps collector notes", () => {
  const summary = summarizeServices([
    { unit: "trim-service.service", activeState: "active", subState: "running" },
    { unit: "fpk-update.timer", activeState: "inactive", subState: "dead" },
    { unit: "slow.service", activeState: "active", subState: "start", note: COLLECT_NOTES.INVALID_OUTPUT }
  ]);
  // 契约字面：只有「有 failed」才 degraded、「全部 unknown」才 unknown，其余 healthy。
  // 混合 unknown 必须在 notes 里留痕，避免故障被静默吞掉。
  assert.equal(summary.verdict, "healthy");
  assert.deepEqual(summary.counts, { running: 1, stopped: 1, failed: 0, unknown: 1 });
  assert.ok(summary.notes.some(note => note.startsWith(`unknown-verdict: slow.service`)), summary.notes.join(" | "));
  assert.ok(summary.notes.some(note => note.startsWith(`${COLLECT_NOTES.INVALID_OUTPUT}: slow.service`)));

  const clean = summarizeServices([
    { unit: "trim-service.service", activeState: "active", subState: "running" },
    { unit: "fpk-update.timer", activeState: "inactive", subState: "dead" }
  ]);
  assert.equal(clean.verdict, "healthy");
  assert.deepEqual(clean.notes, []);
});

test("summarizeServices rejects non-array input and tolerates null entries", () => {
  assert.throws(() => summarizeServices(null), TypeError);
  assert.throws(() => summarizeServices({ unit: "trim.service" }), TypeError);
  const summary = summarizeServices([null, undefined]);
  assert.equal(summary.items.length, 2);
  assert.deepEqual(summary.items.map(item => item.id), ["record-1", "record-2"]);
  assert.equal(summary.verdict, "unknown");
});

// ---------------------------------------------------------------------------
// collectServiceStatus
// ---------------------------------------------------------------------------

test("collectServiceStatus without an injected collector keeps everything unknown", async () => {
  const result = await collectServiceStatus({ units: ["trim-service.service", "docker.socket"] });
  assert.equal(typeof result.collectedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(result.collectedAt)));
  assert.match(result.collectedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(result.items.length, 2);
  for (const item of result.items) {
    assert.equal(item.verdict, "unknown");
    assert.equal(item.note, COLLECT_NOTES.NO_COLLECTOR);
    assert.equal(item.activeState, null);
  }
  assert.equal(result.summary.verdict, "unknown");
  assert.deepEqual(result.summary.counts, { running: 0, stopped: 0, failed: 0, unknown: 2 });
  assert.ok(result.summary.notes.includes("no-collector: trim-service.service, docker.socket"));
  assert.equal(VERDICTS.RUNNING, "running");
});

test("collectServiceStatus parses collector output into verdicts and a healthy summary", async () => {
  const calls = [];
  const texts = new Map([
    ["trim-service.service", SHOW_RUNNING],
    ["fpk-update.timer", showText({ ActiveState: "inactive", SubState: "dead", MainPID: "0", NRestarts: "[not set]" })]
  ]);
  const result = await collectServiceStatus({
    units: ["trim-service.service", "fpk-update.timer"],
    async run(unit) {
      calls.push(unit);
      return texts.get(unit);
    }
  });

  assert.deepEqual(calls, ["trim-service.service", "fpk-update.timer"]);
  const [first, second] = result.items;
  assert.equal(first.verdict, "running");
  assert.equal(first.mainPID, 1234);
  assert.equal(first.memoryCurrentBytes, 52428800);
  assert.equal(first.restartCount, 2);
  assert.equal(first.note, null);
  assert.equal(second.verdict, "stopped");
  assert.equal(second.subState, "dead");
  assert.equal(second.restartCount, null);
  assert.deepEqual(result.summary.counts, { running: 1, stopped: 1, failed: 0, unknown: 0 });
  assert.equal(result.summary.verdict, "healthy");
});

test("collectServiceStatus isolates a single collector failure and truncates its message", async () => {
  const longMessage = "E".repeat(500);
  const result = await collectServiceStatus({
    units: ["trim-service.service", "boom.service"],
    async run(unit) {
      if (unit === "boom.service") throw new Error(longMessage);
      return SHOW_RUNNING;
    }
  });

  const [good, bad] = result.items;
  assert.equal(good.verdict, "running");
  assert.equal(bad.verdict, "unknown");
  assert.equal(bad.note, COLLECT_NOTES.COLLECTOR_FAILED);
  assert.equal(typeof bad.error, "string");
  assert.equal(bad.error.length, MAX_ERROR_MESSAGE_LENGTH);
  assert.equal(MAX_ERROR_MESSAGE_LENGTH, 200);
  assert.ok(result.summary.notes.some(note => note.startsWith("collector-failed: boom.service")));
  assert.equal(result.summary.counts.unknown, 1);
});

test("collectServiceStatus skips invalid unit names without calling the collector", async () => {
  const calls = [];
  const result = await collectServiceStatus({
    units: ["trim-service.service", "../../etc/passwd.service", 42],
    async run(unit) {
      calls.push(unit);
      return SHOW_RUNNING;
    }
  });

  assert.deepEqual(calls, ["trim-service.service"]);
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0].verdict, "running");

  const traversal = result.items[1];
  assert.equal(traversal.unit, "../../etc/passwd.service");
  assert.equal(traversal.verdict, "unknown");
  assert.equal(traversal.note, COLLECT_NOTES.INVALID_UNIT);
  assert.equal(traversal.reason, INVALID_UNIT_REASONS.FORBIDDEN_CHAR);

  const nonString = result.items[2];
  assert.equal(nonString.unit, null);
  assert.equal(nonString.id, "unit-3");
  assert.equal(nonString.note, COLLECT_NOTES.INVALID_UNIT);
  assert.equal(nonString.reason, INVALID_UNIT_REASONS.BAD_SHAPE);
});

test("collectServiceStatus marks unparsable collector output as unknown and never running", async () => {
  const result = await collectServiceStatus({
    units: ["trim-service.service"],
    run: async () => "Loaded: loaded (running)" // 不是 Key=Value 文本
  });
  const [item] = result.items;
  assert.equal(item.verdict, "unknown");
  assert.equal(item.note, COLLECT_NOTES.INVALID_OUTPUT);
  assert.equal(result.summary.verdict, "unknown");
});

test("collectServiceStatus treats a non-function run as no collector", async () => {
  const result = await collectServiceStatus({ units: ["trim-service.service"], run: "systemctl show" });
  assert.equal(result.items[0].note, COLLECT_NOTES.NO_COLLECTOR);
  assert.equal(result.items[0].verdict, "unknown");
});

test("collectServiceStatus enforces the 64-unit bound with RangeError", async () => {
  const tooMany = Array.from({ length: MAX_UNITS + 1 }, (_, index) => `svc-${index}.service`);
  assert.equal(tooMany.length, 65);
  assert.equal(MAX_UNITS, 64);
  await assert.rejects(() => collectServiceStatus({ units: tooMany }), RangeError);
  await assert.rejects(() => collectServiceStatus({ units: "trim-service.service" }), RangeError);
  await assert.rejects(() => collectServiceStatus({}), RangeError);
  await assert.rejects(() => collectServiceStatus(), RangeError);

  const atLimit = Array.from({ length: MAX_UNITS }, (_, index) => `svc-${index}.service`);
  const result = await collectServiceStatus({ units: atLimit, run: async () => SHOW_RUNNING });
  assert.equal(result.items.length, MAX_UNITS);
  assert.equal(result.summary.counts.running, MAX_UNITS);
  assert.equal(result.summary.verdict, "healthy");
});

test("collectServiceStatus returns an empty, unknown summary for an empty unit list", async () => {
  const result = await collectServiceStatus({ units: [], run: async () => SHOW_RUNNING });
  assert.deepEqual(result.items, []);
  assert.equal(result.summary.verdict, "unknown");
  assert.deepEqual(result.summary.notes, ["no-services"]);
});

// ---------------------------------------------------------------------------
// 安全边界：本模块是纯函数层
// ---------------------------------------------------------------------------

test("service-status.mjs stays dependency-free: no imports, no fs/process/network I/O", async () => {
  const source = await readFile(MODULE_PATH, "utf8");
  assert.equal(/^\s*import\s/m.test(source), false, "module must not import anything");
  assert.equal(/require\s*\(/.test(source), false, "module must not require anything");
  for (const specifier of ["node:fs", "node:child_process", "node:http", "node:net", "node:dns", "node:os", "node:path"]) {
    assert.equal(source.includes(specifier), false, `module must not reference ${specifier}`);
  }
  // 模块注释里可以提到 systemctl，但不能真的调用它。
  assert.equal(/(?:^|\W)child_process\s*\.|execSync|spawnSync/.test(source), false);
});

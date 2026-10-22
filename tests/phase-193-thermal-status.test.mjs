import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  COOL_BELOW_C,
  DEFAULT_CRITICAL_C,
  DEFAULT_WARN_C,
  DROP_REASONS,
  MAX_ABSOLUTE_CELSIUS,
  RAW_UNITS,
  THERMAL_CLASSES,
  THERMAL_VERDICTS,
  normalizeThermalReadings,
  parseMilliCelsius,
  summarizeThermals
} from "../apps/fnos-nas-agent/app/thermal-status.mjs";

const MODULE_PATH = new URL("../apps/fnos-nas-agent/app/thermal-status.mjs", import.meta.url);

const EMPTY_COUNTS = { total: 0, cool: 0, normal: 0, warm: 0, hot: 0 };

// ---------------------------------------------------------------------------
// parseMilliCelsius
// ---------------------------------------------------------------------------

test("parseMilliCelsius converts milli-degree strings and numbers into Celsius", () => {
  assert.equal(parseMilliCelsius("45000"), 45);
  assert.equal(parseMilliCelsius("45000\n"), 45, "sysfs output usually carries a trailing newline");
  assert.equal(parseMilliCelsius(" 45000\t"), 45, "leading/trailing whitespace is tolerated");
  assert.equal(parseMilliCelsius("+45000"), 45);
  assert.equal(parseMilliCelsius(45000), 45);
  assert.equal(parseMilliCelsius("-5000"), -5);
  assert.equal(parseMilliCelsius(-5000), -5);
  assert.equal(parseMilliCelsius("0"), 0);
  assert.equal(parseMilliCelsius(0), 0);
  assert.equal(parseMilliCelsius("45123"), 45.123);
  assert.equal(parseMilliCelsius("45500"), 45.5);
});

test("parseMilliCelsius normalizes negative zero so Object.is(-0, 0) confusion cannot leak", () => {
  const parsed = parseMilliCelsius("-0");
  assert.equal(parsed, 0);
  assert.equal(Object.is(parsed, -0), false);
  assert.equal(Object.is(parsed, 0), true);
});

test("parseMilliCelsius returns null for empty, non-numeric and non-finite input", () => {
  for (const value of [
    undefined,
    null,
    "",
    "   ",
    "\n\t",
    "abc",
    "NaN",
    "Infinity",
    "-Infinity",
    true,
    false,
    {},
    [],
    () => 45000
  ]) {
    assert.equal(parseMilliCelsius(value), null, `expected ${String(value)} to be null`);
  }
  assert.equal(parseMilliCelsius(Number.NaN), null);
  assert.equal(parseMilliCelsius(Number.POSITIVE_INFINITY), null);
  assert.equal(parseMilliCelsius(Number.NEGATIVE_INFINITY), null);
});

test("parseMilliCelsius rejects ambiguous numeric formats instead of guessing", () => {
  for (const value of ["1e3", "0x10", "45,000", "45 000", "45°C", "+-45", "--5", "45.5.5", ".", "45."]) {
    assert.equal(parseMilliCelsius(value), null, `expected ${value} to be rejected`);
  }
});

test("parseMilliCelsius enforces the inclusive ±200°C sanity bound", () => {
  assert.equal(MAX_ABSOLUTE_CELSIUS, 200);
  assert.equal(parseMilliCelsius("200000"), 200);
  assert.equal(parseMilliCelsius("-200000"), -200);
  assert.equal(parseMilliCelsius(200000), 200);
  assert.equal(parseMilliCelsius("200001"), null);
  assert.equal(parseMilliCelsius("-200001"), null);
  assert.equal(parseMilliCelsius("999999999999999999999999"), null);
  assert.equal(parseMilliCelsius("".padEnd(400, "9")), null);
});

test("THERMAL_CLASSES exposes the five frozen class names in order", () => {
  assert.deepEqual(THERMAL_CLASSES, ["cool", "normal", "warm", "hot", "unknown"]);
  assert.equal(Object.isFrozen(THERMAL_CLASSES), true);
  assert.equal(THERMAL_VERDICTS.UNKNOWN, "unknown");
  assert.deepEqual(Object.keys(THERMAL_VERDICTS).sort(), ["HOT", "OK", "UNKNOWN", "WARM"]);
});

// ---------------------------------------------------------------------------
// normalizeThermalReadings
// ---------------------------------------------------------------------------

test("normalizeThermalReadings handles both units, sorts by Celsius desc and keeps labels", () => {
  const result = normalizeThermalReadings([
    { source: "cpu", label: "CPU 封装", raw: "45000", unit: "milliCelsius" },
    { source: "board", raw: "52000", unit: "milliCelsius" },
    { source: "nvme", label: "NVMe", raw: "38.5", unit: "celsius" },
    { source: "psu", raw: 41000, unit: "milliCelsius" }
  ]);

  assert.deepEqual(result.readings, [
    { source: "board", label: null, celsius: 52 },
    { source: "cpu", label: "CPU 封装", celsius: 45 },
    { source: "psu", label: null, celsius: 41 },
    { source: "nvme", label: "NVMe", celsius: 38.5 }
  ]);
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(result.notes, []);
});

test("normalizeThermalReadings dedupes by source keeping the hottest reading", () => {
  const result = normalizeThermalReadings([
    { source: "cpu", label: "cpu-first", raw: "40000", unit: "milliCelsius" },
    { source: "cpu", label: "cpu-hotter", raw: "55000", unit: "milliCelsius" },
    { source: "gpu", raw: "70000", unit: "milliCelsius" },
    { source: "gpu", raw: "30000", unit: "milliCelsius" }
  ]);

  assert.deepEqual(result.readings, [
    { source: "gpu", label: null, celsius: 70 },
    { source: "cpu", label: "cpu-hotter", celsius: 55 }
  ]);
  assert.deepEqual(result.notes, ["duplicate-source:cpu", "duplicate-source:gpu"]);
  assert.deepEqual(result.dropped, []);
});

test("normalizeThermalReadings records duplicate-source once even with three or more entries", () => {
  const result = normalizeThermalReadings([
    { source: "cpu", raw: "40000", unit: "milliCelsius" },
    { source: "cpu", raw: "41000", unit: "milliCelsius" },
    { source: "cpu", raw: "42000", unit: "milliCelsius" }
  ]);

  assert.deepEqual(result.notes, ["duplicate-source:cpu"]);
  assert.equal(result.notes.filter((note) => note.startsWith("duplicate-source:")).length, 1);
  assert.deepEqual(result.readings, [{ source: "cpu", label: null, celsius: 42 }]);
});

test("normalizeThermalReadings drops every kind of invalid entry without losing valid ones", () => {
  const result = normalizeThermalReadings([
    null,
    { raw: "45000", unit: "milliCelsius" },
    { source: "   ", raw: "45000", unit: "milliCelsius" },
    { source: "fan", raw: "45000", unit: "kelvin" },
    { source: "hdd", raw: "not-a-number", unit: "milliCelsius" },
    { source: "cpu", raw: "60000", unit: "milliCelsius" }
  ]);

  assert.deepEqual(result.readings, [{ source: "cpu", label: null, celsius: 60 }]);
  assert.deepEqual(result.dropped, [
    { source: null, reason: DROP_REASONS.NOT_OBJECT },
    { source: null, reason: DROP_REASONS.MISSING_SOURCE },
    { source: null, reason: DROP_REASONS.MISSING_SOURCE },
    { source: "fan", reason: DROP_REASONS.BAD_UNIT },
    { source: "hdd", reason: DROP_REASONS.BAD_RAW }
  ]);
  assert.deepEqual(result.notes, [
    "dropped:#1:not-object",
    "dropped:#2:missing-source",
    "dropped:#3:missing-source",
    "dropped:fan:bad-unit",
    "dropped:hdd:bad-raw"
  ]);
});

test("normalizeThermalReadings does not let a dropped entry create a duplicate-source note", () => {
  const result = normalizeThermalReadings([
    { source: "cpu", raw: "bad", unit: "milliCelsius" },
    { source: "cpu", raw: "45000", unit: "milliCelsius" }
  ]);

  assert.deepEqual(result.readings, [{ source: "cpu", label: null, celsius: 45 }]);
  assert.deepEqual(result.notes, ["dropped:cpu:bad-raw"]);
  assert.equal(result.notes.some((note) => note.startsWith("duplicate-source:")), false);
});

test("normalizeThermalReadings keeps label null when absent and rejects non-string labels", () => {
  const result = normalizeThermalReadings([
    { source: "cpu", raw: "45000", unit: "milliCelsius" },
    { source: "gpu", label: 42, raw: "50000", unit: "milliCelsius" },
    { source: "psu", label: "  PSU  ", raw: "40000", unit: "milliCelsius" }
  ]);

  assert.deepEqual(result.readings, [
    { source: "gpu", label: null, celsius: 50 },
    { source: "cpu", label: null, celsius: 45 },
    { source: "psu", label: "PSU", celsius: 40 }
  ]);
});

test("normalizeThermalReadings keeps input order for equal temperatures (stable sort)", () => {
  const result = normalizeThermalReadings([
    { source: "alpha", raw: "40000", unit: "milliCelsius" },
    { source: "beta", raw: "40000", unit: "milliCelsius" }
  ]);
  assert.deepEqual(result.readings.map((reading) => reading.source), ["alpha", "beta"]);
});

test("normalizeThermalReadings returns empty structures for an empty list", () => {
  assert.deepEqual(normalizeThermalReadings([]), { readings: [], dropped: [], notes: [] });
});

test("normalizeThermalReadings rejects non-array input with TypeError", () => {
  for (const value of [undefined, null, {}, "readings", 42, true]) {
    assert.throws(() => normalizeThermalReadings(value), TypeError);
  }
});

// ---------------------------------------------------------------------------
// summarizeThermals
// ---------------------------------------------------------------------------

test("summarizeThermals reports unknown with hottest null for empty input (never 0°C)", () => {
  const summary = summarizeThermals([]);
  assert.deepEqual(summary, {
    verdict: THERMAL_VERDICTS.UNKNOWN,
    counts: EMPTY_COUNTS,
    hottest: null,
    notes: ["no-readings"]
  });
  assert.equal(summary.hottest, null);
});

test("summarizeThermals reports unknown and names unclassifiable entries", () => {
  const summary = summarizeThermals([
    { celsius: 45 },
    { source: "cpu", celsius: "45" },
    { source: "gpu", celsius: Number.NaN },
    { source: "psu", celsius: 250 }
  ]);

  assert.equal(summary.verdict, "unknown");
  assert.deepEqual(summary.counts, EMPTY_COUNTS);
  assert.equal(summary.hottest, null);
  assert.deepEqual(summary.notes, ["no-readings", "invalid-reading: #1, cpu, gpu, psu"]);
});

test("summarizeThermals classifies the exact 5°C / warnC / criticalC boundaries", () => {
  const summary = summarizeThermals([
    { source: "a", celsius: 4.999 },
    { source: "b", celsius: 5 },
    { source: "c", celsius: 64.999 },
    { source: "d", celsius: 65 },
    { source: "e", celsius: 79.999 },
    { source: "f", celsius: 80 }
  ]);

  assert.deepEqual(summary.counts, { total: 6, cool: 1, normal: 2, warm: 2, hot: 1 });
  assert.equal(summary.verdict, "hot");
  assert.deepEqual(summary.hottest, { source: "f", label: null, celsius: 80 });
  assert.deepEqual(summary.notes, []);
});

test("summarizeThermals counts mixed readings, picks the hottest and returns warm", () => {
  const summary = summarizeThermals([
    { source: "cpu", label: "CPU", celsius: 45.5 },
    { source: "gpu", label: "GPU", celsius: 78 },
    { source: "hdd", label: "HDD", celsius: 39 }
  ]);

  assert.equal(summary.verdict, "warm");
  assert.deepEqual(summary.counts, { total: 3, cool: 0, normal: 2, warm: 1, hot: 0 });
  assert.deepEqual(summary.hottest, { source: "gpu", label: "GPU", celsius: 78 });
});

test("summarizeThermals returns ok when nothing reaches the warning threshold", () => {
  const summary = summarizeThermals([
    { source: "a", celsius: -5 },
    { source: "b", celsius: 64.999 }
  ]);

  assert.equal(summary.verdict, "ok");
  assert.deepEqual(summary.counts, { total: 2, cool: 1, normal: 1, warm: 0, hot: 0 });
  assert.deepEqual(summary.hottest, { source: "b", label: null, celsius: 64.999 });
  assert.deepEqual(summary.notes, []);
});

test("summarizeThermals accepts the normalizeThermalReadings result and does not merge its notes", () => {
  const normalized = normalizeThermalReadings([
    { source: "cpu", label: "CPU", raw: "85000", unit: "milliCelsius" },
    { source: "cpu", label: "CPU", raw: "40000", unit: "milliCelsius" },
    { source: "board", raw: "45000", unit: "milliCelsius" }
  ]);
  assert.deepEqual(normalized.notes, ["duplicate-source:cpu"]);

  const summary = summarizeThermals(normalized);
  assert.equal(summary.verdict, "hot");
  assert.deepEqual(summary.counts, { total: 2, cool: 0, normal: 1, warm: 0, hot: 1 });
  assert.deepEqual(summary.hottest, { source: "cpu", label: "CPU", celsius: 85 });
  assert.deepEqual(summary.notes, [], "normalization notes are not silently merged");
});

test("summarizeThermals honors custom thresholds and keeps 5°C as the cool bound", () => {
  const summary = summarizeThermals([
    { source: "a", celsius: 4 },
    { source: "b", celsius: 40 },
    { source: "c", celsius: 50 }
  ], { warnC: 40, criticalC: 50 });

  assert.deepEqual(summary.counts, { total: 3, cool: 1, normal: 0, warm: 1, hot: 1 });
  assert.equal(summary.verdict, "hot");

  // warnC <= 5 时，所有读数都落在 warm/hot/normal 里，cool 桶不会再出现。
  const lowWarning = summarizeThermals([{ source: "a", celsius: 4 }], { warnC: 0, criticalC: 10 });
  assert.deepEqual(lowWarning.counts, { total: 1, cool: 0, normal: 0, warm: 1, hot: 0 });
  assert.equal(lowWarning.verdict, "warm");
});

test("summarizeThermals defaults to warnC 65 / criticalC 80", () => {
  const readings = [{ source: "a", celsius: 70 }];
  const byDefault = summarizeThermals(readings);
  assert.equal(DEFAULT_WARN_C, 65);
  assert.equal(DEFAULT_CRITICAL_C, 80);
  assert.equal(COOL_BELOW_C, 5);
  assert.deepEqual(byDefault, summarizeThermals(readings, {}));
  assert.deepEqual(byDefault, summarizeThermals(readings, null));
  assert.equal(byDefault.verdict, "warm");
});

test("summarizeThermals throws TypeError for illegal warnC/criticalC instead of guessing", () => {
  const readings = [{ source: "a", celsius: 70 }];
  const illegalOptions = [
    { warnC: "65" },
    { warnC: Number.NaN },
    { warnC: Number.POSITIVE_INFINITY },
    { warnC: null },
    { criticalC: "80" },
    { criticalC: Number.NaN },
    { criticalC: Number.NEGATIVE_INFINITY },
    { warnC: 80, criticalC: 80 },
    { warnC: 81, criticalC: 80 },
    { warnC: 65, criticalC: 60 }
  ];

  for (const options of illegalOptions) {
    assert.throws(
      () => summarizeThermals(readings, options),
      TypeError,
      `expected TypeError for ${JSON.stringify(options)}`
    );
  }

  for (const options of [42, "65", true, [], () => {}]) {
    assert.throws(() => summarizeThermals(readings, options), TypeError);
  }
});

test("summarizeThermals rejects non-reading input shapes with TypeError", () => {
  for (const value of [undefined, null, "readings", 42, {}, { readings: null }, { readings: "nope" }]) {
    assert.throws(() => summarizeThermals(value), TypeError);
  }
});

test("summarizeThermals picks the first reading when the hottest temperature ties", () => {
  const summary = summarizeThermals([
    { source: "alpha", celsius: 70 },
    { source: "beta", celsius: 70 }
  ]);
  assert.deepEqual(summary.hottest, { source: "alpha", label: null, celsius: 70 });
});

test("summarizeThermals keeps total equal to the sum of the four class buckets", () => {
  const summary = summarizeThermals([
    { source: "a", celsius: 1 },
    { source: "b", celsius: 20 },
    { source: "c", celsius: 70 },
    { source: "d", celsius: 90 },
    { source: "e", celsius: Number.POSITIVE_INFINITY },
    { celsius: 30 }
  ]);

  const { total, cool, normal, warm, hot } = summary.counts;
  assert.equal(total, 4);
  assert.equal(total, cool + normal + warm + hot);
  assert.deepEqual(summary.notes, ["invalid-reading: e, #6"]);
  assert.equal(summary.verdict, "hot");
});

// ---------------------------------------------------------------------------
// 安全边界：本模块是纯函数层
// ---------------------------------------------------------------------------

test("thermal-status.mjs stays dependency-free: no imports, no fs/process/network I/O", async () => {
  const source = await readFile(MODULE_PATH, "utf8");
  assert.equal(/^\s*import\s/m.test(source), false, "module must not import anything");
  assert.equal(/require\s*\(/.test(source), false, "module must not require anything");
  for (const specifier of [
    "node:fs",
    "node:child_process",
    "node:http",
    "node:net",
    "node:dns",
    "node:os",
    "node:path"
  ]) {
    assert.equal(source.includes(specifier), false, `module must not reference ${specifier}`);
  }
  assert.equal(/(?:^|\W)child_process\s*\.|execSync|spawnSync/.test(source), false);
  assert.deepEqual(RAW_UNITS, { MILLI_CELSIUS: "milliCelsius", CELSIUS: "celsius" });
});

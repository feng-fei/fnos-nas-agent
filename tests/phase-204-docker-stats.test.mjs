import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  DEFAULT_STATS_THRESHOLDS,
  MAX_NAME_LENGTH,
  MAX_SAMPLES,
  STATS_ANOMALY_KINDS,
  STATS_COLUMNS,
  STATS_PARSE_REASONS,
  buildStatsEvidence,
  detectStatsAnomalies,
  parseStatsLine,
  summarizeStats,
} from "../apps/fnos-nas-agent/app/docker-stats.mjs";

const MODULE_SOURCE = await readFile(
  new URL("../apps/fnos-nas-agent/app/docker-stats.mjs", import.meta.url),
  "utf8"
);

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

function jsonLine(overrides = {}) {
  return JSON.stringify({
    Container: "a1b2c3d4e5f6",
    Name: "worklog",
    CPUPerc: "1.50%",
    MemUsage: "12.34MiB / 1GiB",
    MemPerc: "1.21%",
    NetIO: "1.2kB / 3.4kB",
    BlockIO: "0B / 0B",
    PIDs: "7",
    ...overrides,
  });
}

// A clean sample for the judgement layer. Block I/O and pids default to
// unknown so an unrelated test never trips the io-stall check by accident.
function sample(overrides = {}) {
  return {
    name: "worklog",
    cpuPercent: 1.5,
    memUsedBytes: 12 * MIB,
    memLimitBytes: GIB,
    memPercent: 1.2,
    netRxBytes: 1000,
    netTxBytes: 2000,
    blockReadBytes: null,
    blockWriteBytes: null,
    pids: 5,
    ...overrides,
  };
}

test("constants pin the documented columns, bounds and closed enums", () => {
  assert.deepEqual(STATS_COLUMNS, [
    "Container",
    "Name",
    "CPUPerc",
    "MemUsage",
    "MemPerc",
    "NetIO",
    "BlockIO",
    "PIDs",
  ]);
  assert.ok(Object.isFrozen(STATS_COLUMNS));
  assert.ok(Object.isFrozen(DEFAULT_STATS_THRESHOLDS));
  assert.equal(MAX_SAMPLES, 200);
  assert.equal(MAX_NAME_LENGTH, 120);
  assert.deepEqual(Object.values(STATS_PARSE_REASONS).sort(), [
    "empty-line",
    "invalid-cpu",
    "invalid-json",
    "invalid-memory",
    "missing-name",
  ]);
  assert.deepEqual(Object.values(STATS_ANOMALY_KINDS).sort(), [
    "cpu-saturation",
    "io-stall",
    "memory-near-limit",
    "memory-pressure",
    "restart-loop",
  ]);
  assert.deepEqual(DEFAULT_STATS_THRESHOLDS, {
    cpuPercent: 90,
    memoryPercent: 90,
    memoryNearLimitPercent: 98,
    restartCount: 3,
    maxSampleAgeMs: 300000,
  });
});

test("parseStatsLine reads a --format json line", () => {
  assert.deepEqual(parseStatsLine(jsonLine()), {
    ok: true,
    container: {
      id: "a1b2c3d4e5f6",
      name: "worklog",
      cpuPercent: 1.5,
      memUsedBytes: 12939428,
      memLimitBytes: GIB,
      memPercent: 1.21,
      netRxBytes: 1200,
      netTxBytes: 3400,
      blockReadBytes: 0,
      blockWriteBytes: 0,
      pids: 7,
    },
  });
});

test("parseStatsLine reads a {{json .}} object with unknown and extra keys", () => {
  const result = parseStatsLine(
    JSON.stringify({
      ID: "1b2c3d4e5f6",
      Container: "abcdef123456",
      Name: "/api",
      CPUPerc: "0.00%",
      MemUsage: "648B / 1.2kB",
      NetIO: "648B / 1.2kB",
      BlockIO: "1.5KiB / 2MB",
      PIDs: 9,
      SomeFutureKey: "ignored",
    })
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.container, {
    id: "abcdef123456",
    name: "api",
    cpuPercent: 0,
    memUsedBytes: 648,
    memLimitBytes: 1200,
    memPercent: null,
    netRxBytes: 648,
    netTxBytes: 1200,
    blockReadBytes: 1536,
    blockWriteBytes: 2000000,
    pids: 9,
  });
  assert.equal(parseStatsLine(jsonLine()).container.id, "a1b2c3d4e5f6");
});

test("parseStatsLine reads a tabular line and honors custom columns", () => {
  const line = "a1b2c3d4e5f6   worklog   1.50%   12.34MiB / 1GiB   1.21%   1.2kB / 3.4kB   0B / 0B   7";
  assert.deepEqual(parseStatsLine(line), parseStatsLine(jsonLine()));

  const custom = parseStatsLine("worklog   1.50%   1GiB / 2GiB", {
    columns: ["Name", "CPUPerc", "MemUsage"],
  });
  assert.equal(custom.ok, true);
  assert.deepEqual(custom.container, {
    id: "",
    name: "worklog",
    cpuPercent: 1.5,
    memUsedBytes: GIB,
    memLimitBytes: 2 * GIB,
    memPercent: null,
    netRxBytes: null,
    netTxBytes: null,
    blockReadBytes: null,
    blockWriteBytes: null,
    pids: null,
  });

  // One cell short of the 8-column layout is not guessed.
  assert.deepEqual(parseStatsLine("worklog   1.50%   0B / 0B   7"), {
    ok: false,
    reason: "invalid-json",
  });
});

test("parseStatsLine handles cpu percentages strictly", () => {
  assert.equal(parseStatsLine(jsonLine({ CPUPerc: "0.00%" })).container.cpuPercent, 0);
  assert.equal(parseStatsLine(jsonLine({ CPUPerc: "100.00%" })).container.cpuPercent, 100);
  assert.equal(parseStatsLine(jsonLine({ CPUPerc: "12.34%" })).container.cpuPercent, 12.34);
});

test("parseStatsLine converts every documented byte unit", () => {
  const cases = [
    ["0B / 0B", 0, 0],
    ["1.2kB / 1MB", 1200, 1000000],
    ["3.5MB / 1.25GB", 3500000, 1250000000],
    ["1536B / 1.5KiB", 1536, 1536],
    ["12.34MiB / 1GiB", 12939428, GIB],
    ["1TiB / 2TiB", 1099511627776, 2199023255552],
  ];
  for (const [usage, used, limit] of cases) {
    const result = parseStatsLine(jsonLine({ MemUsage: usage }));
    assert.equal(result.ok, true, usage);
    assert.equal(result.container.memUsedBytes, used, usage);
    assert.equal(result.container.memLimitBytes, limit, usage);
  }

  // A number without a unit is never assumed to be bytes.
  for (const usage of ["12 / 34", "12.34MiB / 34", "12MiB / 1GiBB", "1M / 1MB"]) {
    assert.deepEqual(parseStatsLine(jsonLine({ MemUsage: usage })), {
      ok: false,
      reason: "invalid-memory",
    });
  }
});

test("parseStatsLine turns N/A into null without failing", () => {
  const result = parseStatsLine(
    jsonLine({
      CPUPerc: "N/A",
      MemUsage: "N/A",
      MemPerc: "N/A",
      NetIO: "N/A",
      BlockIO: "N/A",
      PIDs: "N/A",
    })
  );
  assert.deepEqual(result, {
    ok: true,
    container: {
      id: "a1b2c3d4e5f6",
      name: "worklog",
      cpuPercent: null,
      memUsedBytes: null,
      memLimitBytes: null,
      memPercent: null,
      netRxBytes: null,
      netTxBytes: null,
      blockReadBytes: null,
      blockWriteBytes: null,
      pids: null,
    },
  });

  // A single N/A part keeps that part unknown while the other part is parsed.
  const partial = parseStatsLine(jsonLine({ MemUsage: "N/A / 1GiB" }));
  assert.equal(partial.ok, true);
  assert.equal(partial.container.memUsedBytes, null);
  assert.equal(partial.container.memLimitBytes, GIB);

  assert.equal(parseStatsLine(jsonLine({ PIDs: "--" })).container.pids, null);
});

test("parseStatsLine rejects an invalid cpu", () => {
  for (const value of ["", "   ", "abc", "12", "1.5 %", "-1%", "NaN%", null, 1.5, "1.5"]) {
    assert.deepEqual(
      parseStatsLine(jsonLine({ CPUPerc: value })),
      { ok: false, reason: "invalid-cpu" },
      `CPUPerc=${JSON.stringify(value)}`
    );
  }
});

test("parseStatsLine rejects invalid memory and memory percent", () => {
  for (const value of ["", "12.34MiB", "12.34MiB /", "/ 1GiB", "12.34 / 1GiB", "N/A / 1GiBB"]) {
    assert.deepEqual(
      parseStatsLine(jsonLine({ MemUsage: value })),
      { ok: false, reason: "invalid-memory" },
      `MemUsage=${JSON.stringify(value)}`
    );
  }

  const withoutUsage = JSON.parse(jsonLine());
  delete withoutUsage.MemUsage;
  assert.deepEqual(parseStatsLine(JSON.stringify(withoutUsage)), {
    ok: false,
    reason: "invalid-memory",
  });

  assert.deepEqual(parseStatsLine(jsonLine({ MemPerc: "abc" })), {
    ok: false,
    reason: "invalid-memory",
  });
  assert.deepEqual(parseStatsLine(jsonLine({ MemPerc: "98" })), {
    ok: false,
    reason: "invalid-memory",
  });
});

test("parseStatsLine reports structural problems with its closed reason list", () => {
  assert.deepEqual(parseStatsLine(""), { ok: false, reason: "empty-line" });
  assert.deepEqual(parseStatsLine("   \t "), { ok: false, reason: "empty-line" });
  assert.deepEqual(parseStatsLine(null), { ok: false, reason: "empty-line" });
  assert.deepEqual(parseStatsLine(undefined), { ok: false, reason: "empty-line" });

  for (const value of ["not-json", "[1,2]", '"text"', "12", "null", "true"]) {
    assert.deepEqual(parseStatsLine(value), { ok: false, reason: "invalid-json" }, value);
  }
  assert.deepEqual(parseStatsLine(42), { ok: false, reason: "invalid-json" });

  for (const value of [undefined, "", "   ", null, "/"]) {
    const row = jsonLine();
    const parsed = JSON.parse(row);
    parsed.Name = value;
    assert.deepEqual(parseStatsLine(JSON.stringify(parsed)), {
      ok: false,
      reason: "missing-name",
    });
  }
});

test("summarizeStats builds the summary and ranks both top lists", () => {
  const summary = summarizeStats(
    [
      sample({ name: "api", cpuPercent: 10, memUsedBytes: 300 }),
      sample({ name: "web", cpuPercent: 50, memUsedBytes: 100 }),
      sample({ name: "db", cpuPercent: 30, memUsedBytes: 200 }),
    ],
    { top: 2 }
  );
  assert.deepEqual(summary, {
    count: 3,
    totalCpuPercent: 90,
    totalMemUsedBytes: 600,
    topCpu: [
      { name: "web", cpuPercent: 50 },
      { name: "db", cpuPercent: 30 },
    ],
    topMemory: [
      { name: "api", memUsedBytes: 300 },
      { name: "db", memUsedBytes: 200 },
    ],
    unknownCount: 0,
    idleCount: 0,
  });

  // Default top is 5; equal values are ordered by name so output is stable.
  const tied = summarizeStats([
    sample({ name: "b", cpuPercent: 10, memUsedBytes: 5 }),
    sample({ name: "a", cpuPercent: 10, memUsedBytes: 5 }),
  ]);
  assert.deepEqual(tied.topCpu, [
    { name: "a", cpuPercent: 10 },
    { name: "b", cpuPercent: 10 },
  ]);
  assert.deepEqual(tied.topMemory, [
    { name: "a", memUsedBytes: 5 },
    { name: "b", memUsedBytes: 5 },
  ]);
  assert.equal(summarizeStats([sample()]).topCpu.length, 1);
});

test("summarizeStats counts idle and unknown samples", () => {
  const summary = summarizeStats([
    sample({ name: "idle-a", cpuPercent: 0 }),
    sample({ name: "idle-b", cpuPercent: 0.05 }),
    sample({ name: "busy", cpuPercent: 0.06 }),
    sample({ name: "unknown", cpuPercent: null }),
  ]);
  assert.equal(summary.count, 4);
  assert.equal(summary.unknownCount, 1);
  assert.equal(summary.idleCount, 2);
  assert.equal(summary.totalCpuPercent, 0.11);
  assert.equal(summary.totalMemUsedBytes, 4 * 12 * MIB);
  assert.deepEqual(summary.topCpu.map(item => item.name), ["busy", "idle-b", "idle-a"]);
  assert.deepEqual(summary.topMemory.map(item => item.name), ["busy", "idle-a", "idle-b", "unknown"]);
});

test("summarizeStats keeps only the newest MAX_SAMPLES", () => {
  const samples = Array.from({ length: MAX_SAMPLES + 5 }, (_, index) =>
    sample({ name: `c-${index}`, cpuPercent: index, memUsedBytes: index })
  );
  const summary = summarizeStats(samples, { top: 1 });
  assert.equal(summary.count, MAX_SAMPLES);
  assert.deepEqual(summary.topCpu, [
    { name: `c-${MAX_SAMPLES + 4}`, cpuPercent: MAX_SAMPLES + 4 },
  ]);
  assert.equal(summary.totalMemUsedBytes, 20900);
  assert.equal(summary.unknownCount, 0);
});

test("summarizeStats handles empty input, wrappers and does not mutate", () => {
  const empty = {
    count: 0,
    totalCpuPercent: 0,
    totalMemUsedBytes: 0,
    topCpu: [],
    topMemory: [],
    unknownCount: 0,
    idleCount: 0,
  };
  assert.deepEqual(summarizeStats([]), empty);
  assert.deepEqual(summarizeStats(null), empty);
  assert.deepEqual(summarizeStats("not-an-array"), empty);
  assert.deepEqual(summarizeStats([null, 42, {}, { name: "   " }]), empty);

  // A parseStatsLine result can be handed over without unwrapping.
  const wrapped = summarizeStats([parseStatsLine(jsonLine())]);
  assert.equal(wrapped.count, 1);
  assert.deepEqual(wrapped.topCpu, [{ name: "worklog", cpuPercent: 1.5 }]);

  const samples = [sample({ name: "api" }), sample({ name: "db", cpuPercent: 0 })];
  const snapshot = structuredClone(samples);
  summarizeStats(samples);
  detectStatsAnomalies(samples);
  assert.deepEqual(samples, snapshot);
});

test("detectStatsAnomalies flags cpu saturation and honors the override", () => {
  assert.deepEqual(detectStatsAnomalies([sample({ cpuPercent: 89.99 })]), []);

  const findings = detectStatsAnomalies([sample({ cpuPercent: 90 })]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "cpu-saturation");
  assert.equal(findings[0].severity, "warning");
  assert.equal(findings[0].container, "worklog");
  assert.match(findings[0].detail, /cpu 90% >= 90%/);

  const overridden = detectStatsAnomalies([sample({ cpuPercent: 60 })], {
    thresholds: { cpuPercent: 55 },
  });
  assert.equal(overridden.length, 1);
  assert.equal(overridden[0].kind, "cpu-saturation");

  // An unparsable override is ignored instead of lowering the bar silently.
  assert.deepEqual(detectStatsAnomalies([sample({ cpuPercent: 60 })], {
    thresholds: { cpuPercent: "abc" },
  }), []);
});

test("detectStatsAnomalies separates memory pressure from near-limit", () => {
  assert.deepEqual(detectStatsAnomalies([sample({ memPercent: 89.99 })]), []);

  const pressure = detectStatsAnomalies([sample({ memPercent: 90 })]);
  assert.equal(pressure.length, 1);
  assert.equal(pressure[0].kind, "memory-pressure");
  assert.equal(pressure[0].severity, "warning");

  const nearLimit = detectStatsAnomalies([sample({ memPercent: 98 })]);
  assert.equal(nearLimit.length, 1);
  assert.equal(nearLimit[0].kind, "memory-near-limit");
  assert.equal(nearLimit[0].severity, "critical");

  const raised = detectStatsAnomalies([sample({ memPercent: 98.5 })], {
    thresholds: { memoryNearLimitPercent: 99 },
  });
  assert.deepEqual(raised.map(item => item.kind), ["memory-pressure"]);

  const lowered = detectStatsAnomalies([sample({ memPercent: 85 })], {
    thresholds: { memoryPercent: 80 },
  });
  assert.deepEqual(lowered.map(item => item.kind), ["memory-pressure"]);
});

test("detectStatsAnomalies flags io-stall only with no growth and stable pids", () => {
  const stalled = detectStatsAnomalies([
    sample({ blockReadBytes: 1000, blockWriteBytes: 500, pids: 4 }),
    sample({ blockReadBytes: 1000, blockWriteBytes: 500, pids: 4 }),
  ]);
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].kind, "io-stall");
  assert.equal(stalled[0].severity, "warning");
  assert.match(stalled[0].detail, /delta 0B <= 0 with pids steady at 4/);

  // A counter reset is not growth either.
  const reset = detectStatsAnomalies([
    sample({ blockReadBytes: 9000, blockWriteBytes: 1000, pids: 4 }),
    sample({ blockReadBytes: 0, blockWriteBytes: 0, pids: 4 }),
  ]);
  assert.deepEqual(reset.map(item => item.kind), ["io-stall"]);

  // Growth means the container did I/O: no stall.
  assert.deepEqual(
    detectStatsAnomalies([
      sample({ blockReadBytes: 1000, blockWriteBytes: 500, pids: 4 }),
      sample({ blockReadBytes: 2000, blockWriteBytes: 500, pids: 4 }),
    ]),
    []
  );

  // A changed pid count means the process set moved: no stall.
  assert.deepEqual(
    detectStatsAnomalies([
      sample({ blockReadBytes: 1000, blockWriteBytes: 500, pids: 4 }),
      sample({ blockReadBytes: 1000, blockWriteBytes: 500, pids: 9 }),
    ]),
    []
  );

  // One sample cannot describe an interval: no stall.
  assert.deepEqual(
    detectStatsAnomalies([sample({ blockReadBytes: 0, blockWriteBytes: 0, pids: 4 })]),
    []
  );
});

test("detectStatsAnomalies flags restart loops from the restart map only", () => {
  assert.deepEqual(detectStatsAnomalies([sample()], { restarts: { worklog: 2 } }), []);

  const loop = detectStatsAnomalies([sample()], { restarts: { worklog: 3 } });
  assert.equal(loop.length, 1);
  assert.equal(loop[0].kind, "restart-loop");
  assert.equal(loop[0].severity, "critical");
  assert.match(loop[0].detail, /restarts 3 >= 3/);

  const numeric = detectStatsAnomalies([sample()], { restarts: { worklog: "3" } });
  assert.deepEqual(numeric.map(item => item.kind), ["restart-loop"]);

  const overridden = detectStatsAnomalies([sample()], {
    restarts: { worklog: 2 },
    thresholds: { restartCount: 2 },
  });
  assert.deepEqual(overridden.map(item => item.kind), ["restart-loop"]);

  // No restart information stays unknown: it is never read as zero.
  assert.deepEqual(detectStatsAnomalies([sample()], { restarts: {} }), []);
  assert.deepEqual(detectStatsAnomalies([sample()]), []);

  // A crash-looping container that produced no stats row is still reported.
  const ghost = detectStatsAnomalies([sample()], { restarts: { crashy: 5 } });
  assert.deepEqual(
    ghost.map(item => [item.container, item.kind, item.severity]),
    [["crashy", "restart-loop", "critical"]]
  );
});

test("detectStatsAnomalies never infers unknown fields into findings", () => {
  // The newest sample is unknown: an older hot reading does not carry over.
  assert.deepEqual(detectStatsAnomalies([sample({ memPercent: 99 }), sample({ memPercent: null })]), []);
  assert.deepEqual(detectStatsAnomalies([sample({ cpuPercent: 99 }), sample({ cpuPercent: null })]), []);

  // memUsedBytes == memLimitBytes with no memPercent is not a memory anomaly.
  assert.deepEqual(
    detectStatsAnomalies([
      sample({ memPercent: null, memUsedBytes: 512 * MIB, memLimitBytes: 512 * MIB }),
    ]),
    []
  );

  // Unknown io endpoint or unknown pid count: no io-stall.
  assert.deepEqual(
    detectStatsAnomalies([sample({ blockReadBytes: null }), sample({ blockReadBytes: 0 })]),
    []
  );
  assert.deepEqual(
    detectStatsAnomalies([
      sample({ blockReadBytes: 0, blockWriteBytes: 0, pids: null }),
      sample({ blockReadBytes: 0, blockWriteBytes: 0, pids: 5 }),
    ]),
    []
  );
});

test("detectStatsAnomalies sorts severities and ignores provably stale samples", () => {
  const sorted = detectStatsAnomalies([
    sample({ name: "z", cpuPercent: 99 }),
    sample({ name: "a", memPercent: 99 }),
  ]);
  assert.deepEqual(sorted.map(item => [item.container, item.severity]), [
    ["a", "critical"],
    ["z", "warning"],
  ]);

  const stale = sample({
    cpuPercent: 99,
    memPercent: 99,
    sampledAt: "2026-10-23T03:00:00+08:00",
  });
  assert.deepEqual(
    detectStatsAnomalies([stale], { now: "2026-10-23T03:30:00+08:00" }),
    []
  );

  const fresh = sample({ cpuPercent: 99, sampledAt: "2026-10-23T03:29:59+08:00" });
  assert.deepEqual(
    detectStatsAnomalies([fresh], { now: "2026-10-23T03:30:00+08:00" }).map(item => item.kind),
    ["cpu-saturation"]
  );

  // Without a timestamp freshness is not provable, so `now` changes nothing.
  assert.equal(
    detectStatsAnomalies([sample({ cpuPercent: 99 })], { now: "2026-10-23T03:30:00+08:00" }).length,
    1
  );
  // Without `now` staleness is not evaluable either.
  assert.equal(detectStatsAnomalies([stale]).length, 2);
  // An unparsable timestamp is unknown, not stale.
  assert.equal(
    detectStatsAnomalies([sample({ cpuPercent: 99, sampledAt: "not-a-date" })], {
      now: "2026-10-23T03:30:00+08:00",
    }).length,
    1
  );
});

test("buildStatsEvidence caps findings and evidence at the limit", () => {
  const samples = [
    sample({ name: "a", cpuPercent: 95 }),
    sample({ name: "b", cpuPercent: 95 }),
    sample({ name: "c", cpuPercent: 95 }),
  ];

  const two = buildStatsEvidence(samples, { limit: 2 });
  assert.equal(two.findings.length, 2);
  assert.equal(two.evidence.length, 2);
  assert.deepEqual(two.findings.map(item => item.container), ["a", "b"]);
  assert.deepEqual(two.evidence.map(item => item.source), ["docker-stats", "docker-stats"]);

  const none = buildStatsEvidence(samples, { limit: 0 });
  assert.deepEqual(none.findings, []);
  assert.deepEqual(none.evidence, []);
  assert.equal(none.summary.count, 3);

  // The default limit is 10; invalid limits fall back to it.
  const many = Array.from({ length: 12 }, (_, index) =>
    sample({ name: `c-${index}`, cpuPercent: 95 })
  );
  assert.equal(buildStatsEvidence(many).findings.length, 10);
  assert.equal(buildStatsEvidence(many, { limit: "5" }).findings.length, 10);
  assert.equal(buildStatsEvidence(many, { limit: -1 }).findings.length, 10);
});

test("buildStatsEvidence truncates names and keeps the evidence shape", () => {
  const longName = "n".repeat(MAX_NAME_LENGTH + 30);
  const samples = [
    sample({ name: longName, cpuPercent: 95 }),
    sample({ name: "db", memPercent: 99 }),
  ];
  const bundle = buildStatsEvidence(samples, { limit: 10 });

  assert.deepEqual(bundle.summary, summarizeStats(samples));
  assert.equal(bundle.findings.length, 2);

  const truncated = `${"n".repeat(MAX_NAME_LENGTH - 3)}...`;
  assert.equal(truncated.length, MAX_NAME_LENGTH);
  assert.deepEqual(bundle.evidence.map(item => item.confidence), ["high", "medium"]);
  assert.ok(bundle.evidence[1].detail.startsWith(`${truncated}: cpu 95% >= 90%`));
  assert.ok(!bundle.evidence[1].detail.includes("n".repeat(MAX_NAME_LENGTH + 1)));
  for (const entry of bundle.evidence) {
    assert.deepEqual(Object.keys(entry).sort(), ["confidence", "detail", "source"]);
    assert.equal(entry.source, "docker-stats");
    assert.equal(typeof entry.detail, "string");
    assert.ok(entry.detail.length <= 240);
  }
});

test("buildStatsEvidence reports the no-sample case without inventing health", () => {
  const empty = buildStatsEvidence([]);
  assert.deepEqual(empty.summary, {
    count: 0,
    totalCpuPercent: 0,
    totalMemUsedBytes: 0,
    topCpu: [],
    topMemory: [],
    unknownCount: 0,
    idleCount: 0,
  });
  assert.deepEqual(empty.findings, []);
  assert.equal(empty.evidence.length, 1);
  assert.deepEqual(empty.evidence[0], {
    source: "docker-stats",
    detail: "no docker-stats sample was supplied; resource usage is unknown",
    confidence: "low",
  });

  // Measured but calm is different: no finding, and no synthetic evidence.
  const calm = buildStatsEvidence([sample({ cpuPercent: 1, memPercent: 1 })]);
  assert.equal(calm.summary.count, 1);
  assert.deepEqual(calm.findings, []);
  assert.deepEqual(calm.evidence, []);
});

test("module stays dependency-free and free of I/O", () => {
  assert.doesNotMatch(MODULE_SOURCE, /^\s*import\s/m);
  assert.doesNotMatch(MODULE_SOURCE, /\brequire\s*\(/);
  const forbidden = [
    "node:fs",
    "node:child_process",
    "node:http",
    "node:net",
    "child_process",
    "fetch(",
    "spawn(",
    "execSync",
    "execFile",
    "process.",
    "new Function",
    "Date.now(",
  ];
  for (const needle of forbidden) {
    assert.equal(
      MODULE_SOURCE.includes(needle),
      false,
      `docker-stats.mjs must not reference ${needle}`
    );
  }
});

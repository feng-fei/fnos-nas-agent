import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  groupBySize,
  detectDuplicates,
  planArchive,
  describeIndexState
} from "../apps/fnos-nas-agent/app/duplicate-detector.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-22T00:00:00.000Z");

function entriesOf(list) {
  return list.map(([path, size, mtimeMs]) => ({ path, size, mtimeMs }));
}

test("groupBySize keeps only groups that hold two or more files", () => {
  const groups = groupBySize(entriesOf([
    ["/data/a.bin", 100],
    ["/data/b.bin", 100],
    ["/data/c.bin", 250]
  ]));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].size, 100);
  assert.deepEqual(groups[0].paths, ["/data/a.bin", "/data/b.bin"]);
});

test("groupBySize sorts the kept groups by size ascending", () => {
  const groups = groupBySize(entriesOf([
    ["/data/d.bin", 900],
    ["/data/e.bin", 900],
    ["/data/f.bin", 300],
    ["/data/g.bin", 300]
  ]));
  assert.deepEqual(groups.map(group => group.size), [300, 900]);
});

test("groupBySize ignores malformed entries", () => {
  const groups = groupBySize([
    { path: "/data/a.bin", size: 10 },
    { path: "/data/b.bin", size: 10 },
    { path: "", size: 10 },
    { path: "/data/c.bin", size: "10" },
    { path: "/data/d.bin" },
    null
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].paths, ["/data/a.bin", "/data/b.bin"]);
});

test("groupBySize returns an empty array for a non array input", () => {
  assert.deepEqual(groupBySize(undefined), []);
  assert.deepEqual(groupBySize("nope"), []);
});

test("detectDuplicates reports files with different sizes as separate", async () => {
  const result = await detectDuplicates({
    listEntries: async () => entriesOf([
      ["/data/a.bin", 100],
      ["/data/b.bin", 200]
    ]),
    readHash: async () => "hash-1"
  });
  assert.equal(result.groups.length, 0);
  assert.equal(result.candidates, 0);
  assert.equal(result.scanned, 2);
  assert.equal(result.truncated, false);
});

test("detectDuplicates groups files that share size and hash", async () => {
  const result = await detectDuplicates({
    listEntries: async () => entriesOf([
      ["/data/a.bin", 100],
      ["/data/b.bin", 100],
      ["/data/c.bin", 100]
    ]),
    readHash: async path => (path.endsWith("c.bin") ? "hash-2" : "hash-1")
  });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].size, 100);
  assert.equal(result.groups[0].hash, "hash-1");
  assert.deepEqual(result.groups[0].paths, ["/data/a.bin", "/data/b.bin"]);
  assert.equal(result.groups[0].wastedBytes, 100);
  assert.equal(result.candidates, 3);
});

test("detectDuplicates reports the wasted bytes of a group", async () => {
  const result = await detectDuplicates({
    listEntries: async () => entriesOf([
      ["/data/a.bin", 512],
      ["/data/b.bin", 512],
      ["/data/c.bin", 512]
    ]),
    readHash: async () => "same"
  });
  assert.equal(result.groups[0].wastedBytes, 512 * 2);
});

test("detectDuplicates only hashes files that share a size", async () => {
  const hashed = [];
  const result = await detectDuplicates({
    listEntries: async () => entriesOf([
      ["/data/unique.bin", 1],
      ["/data/a.bin", 100],
      ["/data/b.bin", 100]
    ]),
    readHash: async path => {
      hashed.push(path);
      return "hash-1";
    }
  });
  assert.deepEqual(hashed, ["/data/a.bin", "/data/b.bin"]);
  assert.equal(result.candidates, 2);
});

test("detectDuplicates sends a failing hash to skipped and never calls it a duplicate", async () => {
  const result = await detectDuplicates({
    listEntries: async () => entriesOf([
      ["/data/a.bin", 100],
      ["/data/b.bin", 100]
    ]),
    readHash: async path => {
      if (path.endsWith("a.bin")) throw new Error("EIO: read failed");
      return "hash-1";
    }
  });
  assert.equal(result.groups.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].path, "/data/a.bin");
  assert.equal(result.skipped[0].reason, "hash-failed");
  assert.match(result.skipped[0].detail, /read failed/);
});

test("detectDuplicates never groups a file whose hash could not be read", async () => {
  const result = await detectDuplicates({
    listEntries: async () => entriesOf([
      ["/data/a.bin", 100],
      ["/data/b.bin", 100]
    ]),
    readHash: async () => {
      throw new Error("permission denied");
    }
  });
  assert.equal(result.groups.length, 0);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.every(item => item.reason === "hash-failed"));
});

test("detectDuplicates skips files larger than maxHashBytes", async () => {
  const result = await detectDuplicates({
    listEntries: async () => entriesOf([
      ["/data/big.bin", 2048],
      ["/data/big2.bin", 2048]
    ]),
    readHash: async () => "hash-1",
    maxHashBytes: 1024
  });
  assert.equal(result.groups.length, 0);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.every(item => item.reason === "too-large"));
});

test("detectDuplicates stops at the limit and reports truncated", async () => {
  const result = await detectDuplicates({
    listEntries: async () => entriesOf([
      ["/data/a.bin", 100],
      ["/data/b.bin", 100],
      ["/data/c.bin", 100],
      ["/data/d.bin", 100]
    ]),
    readHash: async () => "hash-1",
    limit: 2
  });
  assert.equal(result.truncated, true);
  assert.equal(result.scanned, 2);
});

test("detectDuplicates is not truncated when the listing fits the limit", async () => {
  const result = await detectDuplicates({
    listEntries: async () => entriesOf([["/data/a.bin", 100]]),
    readHash: async () => "hash-1",
    limit: 10
  });
  assert.equal(result.truncated, false);
  assert.equal(result.scanned, 1);
});

test("detectDuplicates reports malformed listing entries as skipped", async () => {
  const result = await detectDuplicates({
    listEntries: async () => [{ path: "/data/a.bin", size: 10 }, { path: "", size: 10 }, null],
    readHash: async () => "hash-1"
  });
  assert.equal(result.scanned, 1);
  assert.equal(result.skipped.filter(item => item.reason === "invalid-entry").length, 2);
});

test("detectDuplicates survives a failing listEntries call", async () => {
  const result = await detectDuplicates({
    listEntries: async () => {
      throw new Error("EACCES: denied");
    },
    readHash: async () => "hash-1"
  });
  assert.equal(result.scanned, 0);
  assert.equal(result.groups.length, 0);
  assert.equal(result.skipped[0].reason, "list-failed");
});

test("detectDuplicates rejects a missing listEntries or readHash", async () => {
  await assert.rejects(() => detectDuplicates({ readHash: async () => "h" }), TypeError);
  await assert.rejects(() => detectDuplicates({ listEntries: async () => [] }), TypeError);
  await assert.rejects(() => detectDuplicates({ listEntries: async () => [], readHash: async () => "h", limit: 0 }), TypeError);
});

test("detectDuplicates never returns file contents", async () => {
  const result = await detectDuplicates({
    listEntries: async () => [
      { path: "/data/a.bin", size: 10, mtimeMs: NOW, content: "TOP SECRET CONTENT" },
      { path: "/data/b.bin", size: 10, mtimeMs: NOW, content: "TOP SECRET CONTENT" }
    ],
    readHash: async () => "hash-1"
  });
  const serialised = JSON.stringify(result);
  assert.equal(serialised.includes("TOP SECRET CONTENT"), false);
  assert.deepEqual(Object.keys(result).sort(), ["candidates", "groups", "scanned", "skipped", "truncated"]);
  assert.deepEqual(Object.keys(result.groups[0]).sort(), ["hash", "paths", "size", "wastedBytes"]);
  assert.deepEqual(result.skipped, []);
});

test("planArchive defaults to a dry run and returns a plan only", () => {
  const plan = planArchive(
    entriesOf([["/data/tmp/old.log", 100, NOW - 40 * DAY]]),
    { rules: [{ id: "logs", match: { ext: [".log"] }, target: "/archive/logs" }] }
  );
  assert.equal(plan.dryRun, true);
  assert.equal(plan.moves.length, 1);
  assert.deepEqual(plan.moves[0], {
    from: "/data/tmp/old.log",
    to: "/archive/logs/old.log",
    reason: "rule:logs"
  });
  assert.equal(plan.freedBytes, 100);
});

test("planArchive reports files that no rule matches", () => {
  const plan = planArchive(
    entriesOf([["/data/keep.txt", 10, NOW]]),
    { rules: [{ id: "logs", match: { ext: [".log"] }, target: "/archive/logs" }] }
  );
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, "no-matching-rule");
  assert.equal(plan.freedBytes, 0);
});

test("planArchive matches by name pattern", () => {
  const plan = planArchive(
    entriesOf([["/data/report-2024.pdf", 10, NOW], ["/data/other.pdf", 10, NOW]]),
    { rules: [{ id: "reports", match: { namePattern: "report-*" }, target: "/archive/reports" }] }
  );
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].from, "/data/report-2024.pdf");
});

test("planArchive matches by olderThanDays", () => {
  const plan = planArchive(
    entriesOf([
      ["/data/old.tmp", 10, NOW - 40 * DAY],
      ["/data/new.tmp", 10, NOW - 2 * DAY]
    ]),
    {
      rules: [{ id: "temp", match: { ext: [".tmp"], olderThanDays: 30 }, target: "/archive/tmp" }],
      now: NOW
    }
  );
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].from, "/data/old.tmp");
});

test("planArchive matches by minSizeBytes", () => {
  const plan = planArchive(
    entriesOf([["/data/small.log", 10, NOW], ["/data/big.log", 500, NOW]]),
    {
      rules: [{ id: "big-logs", match: { ext: [".log"], minSizeBytes: 100 }, target: "/archive/logs" }],
      now: NOW
    }
  );
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].from, "/data/big.log");
  assert.equal(plan.freedBytes, 500);
});

test("planArchive refuses to move a file that already lives in the target directory", () => {
  const plan = planArchive(
    entriesOf([["/archive/logs/old.log", 10, NOW - 40 * DAY]]),
    { rules: [{ id: "logs", match: { ext: [".log"] }, target: "/archive/logs" }], now: NOW }
  );
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.skipped[0].reason, "already-in-target");
});

test("planArchive keeps a plan even when dryRun is disabled and performs no file operation", () => {
  const plan = planArchive(
    entriesOf([["/data/tmp/a.tmp", 10, NOW - 40 * DAY]]),
    { rules: [{ id: "temp", match: { ext: [".tmp"] }, target: "/archive/tmp" }], dryRun: false, now: NOW }
  );
  assert.equal(plan.dryRun, false);
  assert.equal(plan.moves.length, 1);
  assert.deepEqual(Object.keys(plan).sort(), ["dryRun", "freedBytes", "moves", "skipped"]);
});

test("planArchive rejects a rule without a target", () => {
  const plan = planArchive(
    entriesOf([["/data/a.log", 10, NOW]]),
    { rules: [{ id: "broken", match: { ext: [".log"] } }], now: NOW }
  );
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.skipped[0].reason, "no-matching-rule");
});

test("planArchive rejects invalid arguments", () => {
  assert.throws(() => planArchive(undefined), TypeError);
  assert.throws(() => planArchive([], { rules: "nope" }), TypeError);
});

test("describeIndexState reports an ok index", () => {
  const state = describeIndexState({
    indexedPaths: 1200,
    excludedPaths: ["/proc", "/sys"],
    lastUpdatedAt: "2026-10-22T00:00:00.000Z"
  });
  assert.equal(state.status, "ok");
  assert.equal(state.indexedPaths, 1200);
  assert.equal(state.excludedCount, 2);
  assert.equal(state.dirty, false);
});

test("describeIndexState reports a stale index when it is dirty", () => {
  const state = describeIndexState({
    indexedPaths: 10,
    lastUpdatedAt: "2026-10-22T00:00:00.000Z",
    dirty: true
  });
  assert.equal(state.status, "stale");
  assert.equal(state.dirty, true);
});

test("describeIndexState reports an unknown index when it was never updated", () => {
  const state = describeIndexState({ indexedPaths: 0 });
  assert.equal(state.status, "unknown");
  assert.equal(state.lastUpdatedAt, null);
  assert.equal(state.excludedCount, 0);
});

test("describeIndexState normalises a numeric timestamp", () => {
  const state = describeIndexState({ indexedPaths: 3, lastUpdatedAt: NOW });
  assert.equal(state.lastUpdatedAt, "2026-10-22T00:00:00.000Z");
  assert.equal(state.status, "ok");
});

test("the module never imports a file system write capability", () => {
  const source = readFileSync(
    new URL("../apps/fnos-nas-agent/app/duplicate-detector.mjs", import.meta.url),
    "utf8"
  );
  assert.equal(/from\s+["']node:fs/.test(source), false);
  assert.equal(/from\s+["']fs/.test(source), false);
  assert.equal(/\b(unlink|rename|writeFile|rm|rmdir|mkdir|copyFile)\s*\(/.test(source), false);
});

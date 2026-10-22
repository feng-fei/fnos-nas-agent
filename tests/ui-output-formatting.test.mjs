import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { readUiSource } from "./helpers/ui-source.mjs";

const html = await readUiSource();
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
const helperStart = script.indexOf("/* Output formatting helpers:");
const helperEnd = script.indexOf("const setupCard=", helperStart);
assert.notEqual(helperStart, -1, "shared output formatters must be present in the UI");
assert.notEqual(helperEnd, -1, "UI formatter block must end before DOM initialization");
const formatterCode = script.slice(helperStart, helperEnd);
const formatters = runInNewContext(formatterCode + "\n({formatBytes,formatDurationSeconds,formatDurationMs,formatDateTime,formatDisplayValue,formatOutputJson})");

test("byte quantities use human-readable common units", () => {
  assert.equal(formatters.formatBytes(0), "0 B");
  assert.equal(formatters.formatBytes(23), "23 B");
  assert.equal(formatters.formatBytes(1024), "1 KB");
  assert.equal(formatters.formatBytes(1024 ** 2), "1 MB");
  assert.equal(formatters.formatBytes(1024 ** 3), "1 GB");
  assert.equal(formatters.formatBytes(1024 ** 4), "1 TB");
  assert.equal(formatters.formatBytes(null), "—");
  assert.equal(formatters.formatBytes(Number.NaN), "—");
});

test("durations use seconds, minutes, hours and days rather than raw seconds", () => {
  assert.equal(formatters.formatDurationSeconds(59), "59 秒");
  assert.equal(formatters.formatDurationSeconds(90), "1 分 30 秒");
  assert.equal(formatters.formatDurationSeconds(3600), "1 小时");
  assert.equal(formatters.formatDurationSeconds(90061), "1 天 1 小时");
  assert.equal(formatters.formatDurationMs(125), "125 ms");
  assert.equal(formatters.formatDurationMs(1250), "1.25 秒");
  assert.equal(formatters.formatDurationMs(65000), "1 分 5 秒");
});

test("structured NAS/tool/task results format byte, duration, percentage and timestamp fields recursively", () => {
  const source = {
    memory: { totalBytes: 16 * 1024 ** 3, usedBytes: 6 * 1024 ** 3, freeBytes: 10 * 1024 ** 3 },
    storage: [{ totalBytes: 4 * 1024 ** 4, usedBytes: 1536 * 1024 ** 3 }],
    archiveBytes: 3 * 1024 ** 2,
    sourceBytesScanned: 2048,
    durationMs: 1250,
    uptimeSeconds: 3600,
    progress: 75,
    createdAt: "2026-10-22T12:00:00.000Z",
    stdout: JSON.stringify({ totalBytes: 1024 ** 3 })
  };
  const parsed = JSON.parse(formatters.formatOutputJson(source));
  assert.equal(parsed.memory.totalBytes, "16 GB");
  assert.equal(parsed.memory.usedBytes, "6 GB");
  assert.equal(parsed.storage[0].totalBytes, "4 TB");
  assert.equal(parsed.storage[0].usedBytes, "1.5 TB");
  assert.equal(parsed.archiveBytes, "3 MB");
  assert.equal(parsed.sourceBytesScanned, "2 KB");
  assert.equal(parsed.durationMs, "1.25 秒");
  assert.equal(parsed.uptimeSeconds, "1 小时");
  assert.equal(parsed.progress, "75%");
  assert.match(parsed.createdAt, /2026/);
  assert.equal(parsed.stdout.totalBytes, "1 GB");
});

test("UI applies formatters to diagnostics, files, Skill outputs, model timing and JSON result areas", () => {
  assert.match(html, /const gib=formatBytes/);
  assert.match(html, /formatDurationSeconds\(x\.system\.uptimeSeconds\)/);
  assert.match(html, /formatBytes\(item\.sizeBytes\)/);
  assert.match(html, /formatBytes\(item\.archiveSizeBytes\)/);
  assert.match(html, /formatBytes\(item\.manifestReview\.sourceBytesScanned\|\|0\)/);
  assert.match(html, /formatBytes\(result\.downloadedBytes\)/);
  assert.match(html, /formatDurationMs\(item\.lastTest\.durationMs\)/);
  assert.match(html, /out\.textContent=formatOutputJson\(payload\.result\)/);
  assert.match(html, /args\.textContent=formatOutputJson\(action\.args\)/);
});

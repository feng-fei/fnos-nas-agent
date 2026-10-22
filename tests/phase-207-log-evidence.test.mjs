import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  LOG_CATEGORIES,
  LOG_KEYWORDS,
  LOG_SEVERITIES,
  LOG_SOURCES,
  MAX_DETAIL_LENGTH,
  MAX_EVIDENCE,
  MAX_LINES,
  buildLogEvidence,
  classifyLogLine,
  parseLogLines,
  redactLogLine
} from "../apps/fnos-nas-agent/app/log-evidence.mjs";

const MODULE_PATH = new URL("../apps/fnos-nas-agent/app/log-evidence.mjs", import.meta.url);

/**
 * 构造一条已经解析过的 entry（buildLogEvidence / classifyLogLine 的输入）。
 *
 * @param {string | null} at
 * @param {string} message
 * @param {string} [level]
 * @param {number} [lineNumber]
 * @returns {object}
 */
function logEntry(at, message, level = "info", lineNumber = 1) {
  return { lineNumber, at, level, message, raw: message, source: "syslog" };
}

// ---------------------------------------------------------------------------
// 常量与关键词表
// ---------------------------------------------------------------------------

test("exports the frozen constants and the seven log categories", () => {
  assert.deepEqual(LOG_SOURCES, ["kernel", "syslog", "docker", "trim"]);
  assert.equal(Object.isFrozen(LOG_SOURCES), true);
  assert.equal(MAX_LINES, 5000);
  assert.equal(MAX_EVIDENCE, 40);
  assert.equal(MAX_DETAIL_LENGTH, 240);
  assert.deepEqual(LOG_CATEGORIES, ["io-error", "oom", "disk", "network", "permission", "service", "unknown"]);
  assert.deepEqual(LOG_SEVERITIES, ["info", "warning", "critical"]);
  assert.equal(Object.isFrozen(LOG_CATEGORIES), true);
});

test("exports the keyword table so tests and callers can inspect it", () => {
  assert.equal(Object.isFrozen(LOG_KEYWORDS), true);
  const categories = LOG_KEYWORDS.map((rule) => rule.category);
  for (const category of ["io-error", "oom", "disk", "network", "permission", "service"]) {
    assert.ok(categories.includes(category), `missing keyword rule for ${category}`);
  }
  assert.equal(categories.includes("unknown"), false);
  for (const rule of LOG_KEYWORDS) {
    assert.equal(Object.isFrozen(rule.patterns), true);
    assert.ok(LOG_SEVERITIES.includes(rule.severity), `bad severity ${rule.severity}`);
    assert.ok(rule.patterns.length > 0, `empty pattern list for ${rule.category}`);
  }
});

// ---------------------------------------------------------------------------
// parseLogLines — 三种输入格式
// ---------------------------------------------------------------------------

test("parses RFC 3164 syslog lines with host, unit and pid", () => {
  const rawFirst = "Oct 23 01:12:33 nas app[123]: first line";
  const rawSecond = "Oct 23 01:12:34 nas kernel: second line";
  const { entries, truncated } = parseLogLines(`${rawFirst}\n${rawSecond}`, { source: "kernel" });

  assert.equal(truncated, false);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    lineNumber: 1,
    at: "Oct 23 01:12:33",
    level: "notice",
    message: "first line",
    raw: rawFirst,
    source: "kernel"
  });
  assert.equal(entries[1].at, "Oct 23 01:12:34");
  assert.equal(entries[1].message, "second line");
  assert.equal(entries[1].source, "kernel");
});

test("parses ISO timestamps with an explicit level token", () => {
  const { entries } = parseLogLines(
    "2026-10-23T01:12:33.123+08:00 ERROR connection refused\n" +
    "2026-10-23T01:12:34.000+08:00 [WARN] disk almost full\n" +
    "2026-10-23T01:12:35.000+08:00 INFO: service ready"
  );

  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.at), [
    "2026-10-23T01:12:33.123+08:00",
    "2026-10-23T01:12:34.000+08:00",
    "2026-10-23T01:12:35.000+08:00"
  ]);
  assert.deepEqual(entries.map((entry) => entry.level), ["err", "warning", "info"]);
  assert.deepEqual(entries.map((entry) => entry.message), ["connection refused", "disk almost full", "service ready"]);
  assert.equal(entries[0].raw, "2026-10-23T01:12:33.123+08:00 ERROR connection refused");
});

test("parses docker json-file records and reads the log field, not the JSON line", () => {
  const raw = "{\"log\":\"Buffer I/O error on dev sda\\n\",\"stream\":\"stderr\",\"time\":\"2026-10-23T01:12:33.123456789Z\"}";
  const { entries, truncated } = parseLogLines(raw, { source: "docker" });

  assert.equal(truncated, false);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message, "Buffer I/O error on dev sda");
  assert.equal(entries[0].at, "2026-10-23T01:12:33.123456789Z");
  assert.equal(entries[0].raw, raw);
  assert.equal(entries[0].source, "docker");
  // stream=stderr 不是级别字段：保持 notice，不据此抬升 severity。
  assert.equal(entries[0].level, "notice");

  // 前缀断言：docker 行被解析成日志正文，而不是把整段 JSON 当消息。
  assert.notEqual(entries[0].message, raw);
  assert.equal(entries[0].message.includes("\""), false);
});

test("keeps lines without a timestamp as plain messages with at=null", () => {
  const raw = "some message without any timestamp";
  const { entries } = parseLogLines(raw);

  assert.deepEqual(entries, [{
    lineNumber: 1,
    at: null,
    level: "notice",
    message: raw,
    raw,
    source: "syslog"
  }]);
});

test("falls back to a plain message when a timestamp-shaped line is invalid", () => {
  const { entries } = parseLogLines("2026-99-99T99:99:99Z strange timestamp");

  assert.equal(entries.length, 1);
  assert.equal(entries[0].at, null);
  assert.equal(entries[0].message, "2026-99-99T99:99:99Z strange timestamp");
  assert.equal(entries[0].level, "notice");
});

// ---------------------------------------------------------------------------
// parseLogLines — MAX_LINES
// ---------------------------------------------------------------------------

test("keeps only the newest MAX_LINES lines and reports truncated", () => {
  const text = Array.from({ length: MAX_LINES + 1 }, (_, index) => `line ${index}`).join("\n");
  const { entries, truncated } = parseLogLines(text);

  assert.equal(truncated, true);
  assert.equal(entries.length, MAX_LINES);
  assert.equal(entries[0].lineNumber, 2);
  assert.equal(entries[0].message, "line 1");
  assert.equal(entries[entries.length - 1].lineNumber, MAX_LINES + 1);
  assert.equal(entries[entries.length - 1].message, `line ${MAX_LINES}`);
});

test("does not report truncation for exactly MAX_LINES lines with a trailing newline", () => {
  const text = `${Array.from({ length: MAX_LINES }, (_, index) => `line ${index}`).join("\n")}\n`;
  const { entries, truncated } = parseLogLines(text);

  assert.equal(truncated, false);
  assert.equal(entries.length, MAX_LINES);
  assert.equal(entries[0].lineNumber, 1);
});

// ---------------------------------------------------------------------------
// classifyLogLine — 分类与 severity
// ---------------------------------------------------------------------------

test("classifies all seven categories from the keyword table", () => {
  const cases = [
    ["Buffer I/O error on dev sda1, logical block 42", "io-error", "critical"],
    ["Out of memory: Killed process 4242 (postgres)", "oom", "critical"],
    ["No space left on device", "disk", "critical"],
    ["connect() failed: Connection refused", "network", "warning"],
    ["Permission denied (publickey)", "permission", "warning"],
    ["Failed to start nginx.service: Unit not found", "service", "warning"],
    ["everything looks nominal", "unknown", "info"]
  ];

  for (const [message, category, severity] of cases) {
    assert.deepEqual(
      classifyLogLine({ level: "info", message }),
      { category, severity },
      `unexpected classification for: ${message}`
    );
  }
});

test("upgrades severity for critical keywords instead of following the level", () => {
  assert.deepEqual(classifyLogLine({ level: "info", message: "Out of memory" }), {
    category: "oom",
    severity: "critical"
  });
  assert.deepEqual(classifyLogLine({ level: "debug", message: "Buffer I/O error on dev sdb" }), {
    category: "io-error",
    severity: "critical"
  });
});

test("never downgrades a critical level because the keyword is only a warning", () => {
  assert.deepEqual(classifyLogLine({ level: "crit", message: "connection refused" }), {
    category: "network",
    severity: "critical"
  });
});

test("prefers the root cause over the symptom when several keywords match", () => {
  const result = classifyLogLine({ level: "warning", message: "Failed to start: No space left on device" });
  assert.deepEqual(result, { category: "disk", severity: "critical" });
});

test("maps unknown content to unknown and keeps the level baseline", () => {
  assert.deepEqual(classifyLogLine({ level: "ERROR", message: "service restarted cleanly" }), {
    category: "unknown",
    severity: "warning"
  });
  assert.deepEqual(classifyLogLine({ level: "info", message: "" }), {
    category: "unknown",
    severity: "info"
  });
});

// ---------------------------------------------------------------------------
// buildLogEvidence — 窗口合并
// ---------------------------------------------------------------------------

test("merges same category+severity inside the 60s window and records first/last timestamps", () => {
  const entries = [
    logEntry("2026-10-23T01:00:00.000Z", "Connection refused"),
    logEntry("2026-10-23T01:00:30.000Z", "Connection refused again"),
    logEntry("2026-10-23T01:02:30.000Z", "Connection refused later")
  ];
  const { evidence, groups } = buildLogEvidence(entries);

  assert.equal(groups.length, 2);
  assert.equal(evidence.length, 2);
  assert.deepEqual(evidence[0], {
    source: "log",
    category: "network",
    severity: "warning",
    count: 2,
    firstAt: "2026-10-23T01:00:00.000Z",
    lastAt: "2026-10-23T01:00:30.000Z",
    detail: "Connection refused"
  });
  assert.equal(evidence[1].count, 1);
  assert.equal(evidence[1].firstAt, "2026-10-23T01:02:30.000Z");
});

test("splits groups when the gap exceeds the configured window", () => {
  const entries = [
    logEntry("2026-10-23T01:00:00.000Z", "Connection refused"),
    logEntry("2026-10-23T01:00:30.000Z", "Connection refused again"),
    logEntry("2026-10-23T01:02:30.000Z", "Connection refused later")
  ];
  const { evidence } = buildLogEvidence(entries, { groupWindowMs: 1000 });

  assert.equal(evidence.length, 3);
  assert.deepEqual(evidence.map((item) => item.count), [1, 1, 1]);
});

test("merges entries without timestamps into a single null-time group", () => {
  const entries = [
    logEntry(null, "Permission denied"),
    logEntry(null, "Permission denied again"),
    logEntry("2026-10-23T01:00:00.000Z", "Permission denied at time")
  ];
  const { evidence } = buildLogEvidence(entries);

  const untimed = evidence.find((item) => item.firstAt === null);
  assert.ok(untimed, "expected one group with null timestamps");
  assert.equal(untimed.count, 2);
  assert.equal(untimed.lastAt, null);
  assert.equal(untimed.detail, "Permission denied");
  const timed = evidence.find((item) => item.firstAt !== null);
  assert.equal(timed.count, 1);
  assert.equal(timed.firstAt, "2026-10-23T01:00:00.000Z");
});

// ---------------------------------------------------------------------------
// buildLogEvidence — detail 截断与脱敏
// ---------------------------------------------------------------------------

test("truncates detail to MAX_DETAIL_LENGTH code points and marks the cut", () => {
  const long = "x".repeat(400);
  const { evidence } = buildLogEvidence([logEntry(null, long)]);

  assert.equal(evidence.length, 1);
  assert.equal(Array.from(evidence[0].detail).length, MAX_DETAIL_LENGTH);
  assert.equal(evidence[0].detail.endsWith("…"), true);
  assert.equal(evidence[0].detail.length, MAX_DETAIL_LENGTH);
});

test("redacts password-like assignments", () => {
  const detail = redactLogLine("login password=hunter2 token: abc123 secret=\"top secret value\"");

  assert.equal(detail, "login password=[redacted] token: [redacted] secret=[redacted]");
  assert.equal(detail.includes("hunter2"), false);
  assert.equal(detail.includes("abc123"), false);
  assert.equal(detail.includes("top secret value"), false);
});

test("redacts sk-/ghp_/AKIA token shapes", () => {
  const detail = redactLogLine(
    "keys sk-proj-abc123DEF456ghi and ghp_1234567890abcdef and AKIAIOSFODNN7EXAMPLE leaked"
  );

  assert.equal(detail, "keys [redacted] and [redacted] and [redacted] leaked");
  assert.equal(detail.includes("sk-proj"), false);
  assert.equal(detail.includes("ghp_"), false);
  assert.equal(detail.includes("AKIA"), false);
});

test("redacts Bearer credentials but keeps the header readable", () => {
  const detail = redactLogLine("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig");

  assert.equal(detail, "Authorization: Bearer [redacted]");
  assert.equal(detail.includes("eyJhbGciOiJIUzI1NiJ9"), false);
});

test("redacts local home directory prefixes on posix and windows paths", () => {
  const detail = redactLogLine(
    "open /home/alice/.ssh/id_rsa failed for /root/.config and C:\\Users\\Administrator\\AppData"
  );

  assert.equal(detail, "open [redacted]/.ssh/id_rsa failed for [redacted]/.config and [redacted]\\AppData");
  assert.equal(detail.includes("alice"), false);
  assert.equal(detail.includes("Administrator"), false);
});

test("strips ANSI escapes and control characters", () => {
  const detail = redactLogLine("\u001b[31mERROR\u001b[0m: disk\u0000 full\u0007");

  assert.equal(detail, "ERROR: disk full");
  assert.equal(/[\u0000-\u001f\u007f]/.test(detail), false);
  assert.equal(detail.includes("\u001b"), false);
});

// ---------------------------------------------------------------------------
// buildLogEvidence — 条数上限、排序与形状
// ---------------------------------------------------------------------------

test("caps evidence at MAX_EVIDENCE but reports every merged group", () => {
  const entries = [];
  for (let index = 0; index < MAX_EVIDENCE + 5; index += 1) {
    const at = new Date(Date.UTC(2026, 9, 23, 0, 0, 0) + index * 5 * 60_000).toISOString();
    entries.push(logEntry(at, "Permission denied", "err", index + 1));
  }

  const result = buildLogEvidence(entries);
  assert.equal(result.evidence.length, MAX_EVIDENCE);
  assert.equal(result.groups.length, MAX_EVIDENCE + 5);
  assert.equal(buildLogEvidence(entries, { limit: 3 }).evidence.length, 3);
  assert.equal(buildLogEvidence(entries, { limit: 0 }).evidence.length, 0);
  assert.equal(buildLogEvidence(entries, { limit: 0 }).groups.length, MAX_EVIDENCE + 5);
});

test("sorts evidence by severity, count and time and never carries the raw line", () => {
  const entries = [
    logEntry("2026-10-23T01:02:00.000Z", "everything fine"),
    logEntry("2026-10-23T01:01:00.000Z", "connection refused"),
    logEntry("2026-10-23T01:00:00.000Z", "Out of memory: killed process, password=hunter2"),
    logEntry("2026-10-23T01:00:10.000Z", "Out of memory again")
  ];
  const { evidence } = buildLogEvidence(entries);

  assert.deepEqual(evidence.map((item) => item.severity), ["critical", "warning", "info"]);
  assert.deepEqual(Object.keys(evidence[0]).sort(), [
    "category",
    "count",
    "detail",
    "firstAt",
    "lastAt",
    "severity",
    "source"
  ]);
  assert.equal("raw" in evidence[0], false);
  assert.equal(evidence[0].source, "log");
  assert.equal(evidence[0].category, "oom");
  assert.equal(evidence[0].count, 2);
  assert.equal(evidence[0].detail.startsWith("Out of memory"), true);
  assert.equal(evidence[0].detail.includes("hunter2"), false);
  assert.equal(evidence[0].detail.includes("password=[redacted]"), true);
  assert.equal(evidence[2].category, "unknown");
  assert.equal(evidence[2].severity, "info");
});

// ---------------------------------------------------------------------------
// 空输入、来源归一与安全红线
// ---------------------------------------------------------------------------

test("returns empty results for empty or invalid input without throwing", () => {
  assert.deepEqual(parseLogLines(""), { entries: [], truncated: false });
  assert.deepEqual(parseLogLines(null), { entries: [], truncated: false });
  assert.deepEqual(parseLogLines(42), { entries: [], truncated: false });
  assert.deepEqual(buildLogEvidence([]), { evidence: [], groups: [] });
  assert.deepEqual(buildLogEvidence(null), { evidence: [], groups: [] });
  assert.deepEqual(buildLogEvidence(undefined), { evidence: [], groups: [] });
});

test("normalizes the log source and falls back to syslog for unknown names", () => {
  const line = "Oct 23 01:12:33 nas app: message";

  assert.equal(parseLogLines(line).entries[0].source, "syslog");
  assert.equal(parseLogLines(line, { source: "KERNEL" }).entries[0].source, "kernel");
  assert.equal(parseLogLines(line, { source: "apache" }).entries[0].source, "syslog");
  assert.equal(parseLogLines(line, { source: "docker" }).entries[0].source, "docker");
});

test("stays pure: no imports, no process spawning and no filesystem access", async () => {
  const source = await readFile(MODULE_PATH, "utf8");

  assert.equal(/(^|\n)\s*import\s/.test(source), false, "module must not import anything");
  assert.equal(/\brequire\s*\(/.test(source), false, "module must not require anything");
  assert.equal(
    /\b(?:child_process|node:fs|node:net|node:http|node:https|node:dns|node:os|node:worker_threads)\b/.test(source),
    false,
    "module must not reference process or I/O APIs"
  );
  assert.equal(/\b(?:execSync|spawnSync|execFile)\s*\(/.test(source), false, "module must not spawn processes");
});

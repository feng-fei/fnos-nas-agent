import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  DEFAULT_REPEAT_LIMIT,
  EVENT_LEVELS,
  MAX_MESSAGE_LENGTH,
  normalizeEventMessage,
  parseLogLines,
  summarizeEvents
} from "../apps/fnos-nas-agent/app/system-events.mjs";

const MODULE_PATH = new URL("../apps/fnos-nas-agent/app/system-events.mjs", import.meta.url);

const ZERO_COUNTS = {
  emerg: 0,
  alert: 0,
  crit: 0,
  err: 0,
  warning: 0,
  notice: 0,
  info: 0,
  debug: 0
};

// ---------------------------------------------------------------------------
// EVENT_LEVELS
// ---------------------------------------------------------------------------

test("EVENT_LEVELS lists the eight syslog severities from emerg to debug", () => {
  assert.deepEqual(EVENT_LEVELS, ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"]);
  assert.equal(Object.isFrozen(EVENT_LEVELS), true);
  assert.equal(MAX_MESSAGE_LENGTH, 240);
  assert.equal(DEFAULT_REPEAT_LIMIT, 20);
});

// ---------------------------------------------------------------------------
// parseLogLines — kmsg
// ---------------------------------------------------------------------------

test("parseLogLines maps kmsg <N> prefixes to the matching severity and never invents a timestamp", () => {
  const text = EVENT_LEVELS.map((_, index) => `<${index}>kernel message ${index}`).join("\n");
  const result = parseLogLines(text);

  assert.equal(result.events.length, 8);
  assert.equal(result.dropped, 0);
  assert.deepEqual(result.events.map(event => event.level), EVENT_LEVELS);
  for (const event of result.events) {
    assert.equal(event.source, "kernel");
    assert.equal(event.timestamp, null);
    assert.deepEqual(Object.keys(event), ["level", "source", "timestamp", "message"]);
  }
  assert.equal(result.events[0].message, "kernel message 0");
  assert.deepEqual(result.notes, []);
});

test("parseLogLines decodes facility-encoded kmsg PRI values instead of dropping them", () => {
  const result = parseLogLines("<38>auth info line\n<35>auth err line\n<999>weird line");

  assert.deepEqual(result.events.map(event => event.level), ["info", "err", "notice"]);
  assert.equal(result.dropped, 0);
  assert.ok(result.notes.includes("pri-decoded: 2 line(s)"), result.notes.join(" | "));
  assert.ok(result.notes.includes("unknown-level: 1 line(s) mapped to notice"), result.notes.join(" | "));
});

test("parseLogLines strips the monotonic bracket from kmsg messages but keeps detail colons", () => {
  const result = parseLogLines("<6>[ 1234.567890] usb 1-1: new high-speed USB device\n<4>[    0.000000] out of memory");

  assert.equal(result.events[0].message, "usb 1-1: new high-speed USB device");
  assert.equal(result.events[1].level, "warning");
  assert.equal(result.events[1].message, "out of memory");
});

// ---------------------------------------------------------------------------
// parseLogLines — facility.level 与 journalctl short
// ---------------------------------------------------------------------------

test("parseLogLines reads facility.level prefixes and keeps the facility as source", () => {
  const result = parseLogLines("kern.err: eth0: link down\nuser.warning: quota nearly full\nKERN.CRIT: hard failure");

  assert.deepEqual(result.events.map(event => event.level), ["err", "warning", "crit"]);
  assert.deepEqual(result.events.map(event => event.source), ["kern", "user", "kern"]);
  assert.equal(result.events[0].message, "eth0: link down");
  assert.equal(result.events[2].message, "hard failure");
  assert.equal(result.dropped, 0);
});

test("parseLogLines parses journalctl short lines and maps their missing priority to notice", () => {
  const result = parseLogLines(
    "Oct 24 01:02:03 fnos sshd[4321]: Accepted publickey for root from 192.168.1.5 port 22 ssh2"
  );
  const [event] = result.events;

  assert.equal(event.level, "notice");
  assert.equal(event.source, "sshd");
  assert.equal(event.timestamp, "Oct 24 01:02:03");
  assert.equal(event.message, "Accepted publickey for root from 192.168.1.5 port 22 ssh2");
  assert.equal(result.dropped, 0);
  assert.ok(result.notes.includes("journalctl-priority-missing: 1 line(s) mapped to notice"), result.notes.join(" | "));
});

test("parseLogLines normalises journalctl day padding and accepts units without a pid", () => {
  const result = parseLogLines("Oct  4 09:05:06 nas kernel: [  1.234567] EXT4-fs mounted");
  const [event] = result.events;

  assert.equal(result.events.length, 1);
  assert.equal(event.timestamp, "Oct 4 09:05:06");
  assert.equal(event.source, "kernel");
  assert.equal(event.message, "[  1.234567] EXT4-fs mounted");
});

// ---------------------------------------------------------------------------
// parseLogLines — 纯 LEVEL、控制字符、截断
// ---------------------------------------------------------------------------

test("parseLogLines parses plain LEVEL lines, maps common aliases, and falls back to notice", () => {
  const result = parseLogLines([
    "err: disk failure",
    "ERROR: disk failure again",
    "WARN: latency spike",
    "fatal: process lost",
    "trace: detail",
    "Mystery: what is this"
  ].join("\n"));

  assert.deepEqual(
    result.events.map(event => event.level),
    ["err", "err", "warning", "crit", "debug", "notice"]
  );
  assert.deepEqual(result.events.map(event => event.source), Array(6).fill("log"));
  assert.equal(result.dropped, 0);
  assert.ok(result.notes.includes("unknown-level: 1 line(s) mapped to notice"), result.notes.join(" | "));
});

test("parseLogLines normalises control characters to single spaces", () => {
  const result = parseLogLines("<3>disk\tfailure\u0000detected\u0007now\n");

  assert.equal(result.events[0].message, "disk failure detected now");
});

test("parseLogLines truncates every message at 240 code points and reports it", () => {
  const long = "x".repeat(300);
  const result = parseLogLines(`<3>${long}\nerr: short\n`);

  assert.equal(result.events[0].message.length, MAX_MESSAGE_LENGTH);
  assert.equal(result.events[1].message, "short");
  assert.ok(result.notes.includes("truncated: 1 message(s)"), result.notes.join(" | "));
});

test("parseLogLines skips blank lines and reconciles dropped with the notes", () => {
  const lines = [
    "",
    "   ",
    "<3>boom",
    "no level here",
    "kern.notice: fine",
    "totally unrecognised",
    "\t",
    "<6>kmsg ok"
  ];
  const result = parseLogLines(lines.join("\r\n"));
  const blankLines = lines.filter(line => line.trim() === "").length;

  assert.equal(blankLines, 3);
  assert.equal(result.events.length, 3);
  assert.equal(result.dropped, 2);
  // 对账：事件 + 丢弃 + 空行 == 总行数，且 notes 里的数字与 dropped 一致。
  assert.equal(result.events.length + result.dropped + blankLines, lines.length);

  const note = result.notes.find(item => item.startsWith("dropped:"));
  assert.ok(note, "a dropped note must be present");
  assert.equal(Number(/^dropped: (\d+)/.exec(note)[1]), result.dropped);
});

test("parseLogLines returns an empty result with a note for non-string input", () => {
  for (const value of [undefined, null, 42, {}, []]) {
    const result = parseLogLines(value);
    assert.deepEqual(result.events, []);
    assert.equal(result.dropped, 0);
    assert.deepEqual(result.notes, ["invalid-input: expected log text"]);
  }
  // 纯空文本没有异常，notes 为空而不是 invalid-input。
  assert.deepEqual(parseLogLines(""), { events: [], dropped: 0, notes: [] });
});

// ---------------------------------------------------------------------------
// normalizeEventMessage
// ---------------------------------------------------------------------------

test("normalizeEventMessage replaces paths, UUIDs, hex and numbers with stable placeholders", () => {
  assert.equal(
    normalizeEventMessage("PID 4321 died at 0xDEADBEEF on /var/log/app.log for 5c1f2a9e-3b4d-4f6a-9c8e-2d1b0a9f8e7d"),
    "pid <num> died at <hex> on <path> for <uuid>"
  );
});

test("normalizeEventMessage lowercases and collapses whitespace and control characters", () => {
  assert.equal(normalizeEventMessage("  Disk   ERROR\tat  EVENING  "), "disk error at evening");
});

test("normalizeEventMessage gives one group key for repeated events with different identifiers", () => {
  const first = normalizeEventMessage("Connection to 192.168.1.5:22 failed after 3 retries");
  const second = normalizeEventMessage("Connection to 10.0.0.9:2222 failed after 12 retries");

  assert.equal(first, second);
  assert.equal(first, "connection to <num>.<num>:<num> failed after <num> retries");
});

test("normalizeEventMessage returns an empty string for non-text or blank input", () => {
  for (const value of [undefined, null, 42, {}, []]) {
    assert.equal(normalizeEventMessage(value), "");
  }
  assert.equal(normalizeEventMessage("   \t\n "), "");
});

// ---------------------------------------------------------------------------
// summarizeEvents — 结论
// ---------------------------------------------------------------------------

test("summarizeEvents reports unknown for empty input instead of ok", () => {
  for (const input of [[], { events: [] }, parseLogLines("")]) {
    const summary = summarizeEvents(input);
    assert.equal(summary.verdict, "unknown");
    assert.deepEqual(summary.counts, ZERO_COUNTS);
    assert.deepEqual(summary.repeated, []);
    assert.deepEqual(summary.notes, ["no-events"]);
  }
});

test("summarizeEvents maps err to warning, crit/alert/emerg to critical and info-only to ok", () => {
  const warning = summarizeEvents([
    { level: "err", message: "a" },
    { level: "warning", message: "b" },
    { level: "info", message: "c" }
  ]);
  assert.equal(warning.verdict, "warning");

  for (const level of ["crit", "alert", "emerg"]) {
    const summary = summarizeEvents([
      { level: "err", message: "a" },
      { level, message: "b" }
    ]);
    assert.equal(summary.verdict, "critical", `expected ${level} to be critical`);
  }

  const ok = summarizeEvents([
    { level: "notice", message: "a" },
    { level: "info", message: "b" },
    { level: "debug", message: "c" }
  ]);
  assert.equal(ok.verdict, "ok");
  assert.deepEqual(ok.counts, { ...ZERO_COUNTS, notice: 1, info: 1, debug: 1 });
});

// ---------------------------------------------------------------------------
// summarizeEvents — repeated
// ---------------------------------------------------------------------------

test("summarizeEvents orders repeated groups by count then by first appearance", () => {
  const summary = summarizeEvents([
    { level: "warning", message: "disk 1 slow" },
    { level: "err", message: "disk 2 slow" },
    { level: "warning", message: "disk 3 slow" },
    { level: "err", message: "other failure" },
    { level: "notice", message: "disk 4 slow" }
  ]);

  assert.equal(summary.repeated.length, 2);
  assert.deepEqual(summary.repeated[0], {
    normalized: "disk <num> slow",
    count: 4,
    firstSample: "disk 1 slow",
    level: "warning"
  });
  assert.deepEqual(summary.repeated[1], {
    normalized: "other failure",
    count: 1,
    firstSample: "other failure",
    level: "err"
  });

  const tie = summarizeEvents([
    { level: "info", message: "alpha 1" },
    { level: "info", message: "beta 2" },
    { level: "info", message: "alpha 3" },
    { level: "info", message: "beta 4" }
  ]);
  assert.deepEqual(tie.repeated.map(group => group.normalized), ["alpha <num>", "beta <num>"]);
  assert.deepEqual(tie.repeated.map(group => group.count), [2, 2]);
});

test("summarizeEvents keeps the raw first sample, capped at 240, at the first occurrence level", () => {
  const long = "Disk 42 SPEED dropped " + "z".repeat(300);
  const summary = summarizeEvents([
    { level: "warning", message: long },
    { level: "err", message: long.replace("42", "43") },
    { level: "warning", message: "disk 1 short" }
  ]);

  const group = summary.repeated.find(item => item.count === 2);
  assert.ok(group, "the two long messages must group together");
  assert.equal(group.level, "warning");
  assert.equal(group.firstSample.length, MAX_MESSAGE_LENGTH);
  assert.ok(group.firstSample.startsWith("Disk 42 SPEED dropped"));
  assert.ok(summary.notes.includes("sample-truncated: 1 first sample(s)"), summary.notes.join(" | "));
});

test("summarizeEvents rejects invalid limits with TypeError and honours a valid limit", () => {
  for (const limit of [0, -1, 1.5, 2.0000001, "20", null, NaN, Infinity]) {
    assert.throws(() => summarizeEvents([], { limit }), TypeError, `expected limit=${String(limit)} to throw`);
  }

  const events = ["alpha", "beta", "gamma"].map(message => ({ level: "info", message }));
  const limited = summarizeEvents(events, { limit: 2 });
  assert.equal(limited.repeated.length, 2);
  assert.ok(limited.notes.includes("repeated-truncated: 1 group(s) omitted"), limited.notes.join(" | "));

  const many = Array.from({ length: DEFAULT_REPEAT_LIMIT + 2 }, (_, index) => ({
    level: "info",
    message: `msg ${"a".repeat(index + 1)}`
  }));
  const defaulted = summarizeEvents(many);
  assert.equal(defaulted.repeated.length, DEFAULT_REPEAT_LIMIT);
  assert.ok(defaulted.notes.includes("repeated-truncated: 2 group(s) omitted"), defaulted.notes.join(" | "));
});

test("summarizeEvents rejects non-event input and ignores events without a known level", () => {
  for (const input of [null, undefined, 42, "events", {}, { events: "nope" }]) {
    assert.throws(() => summarizeEvents(input), TypeError);
  }

  const summary = summarizeEvents([
    { level: "bogus", message: "x" },
    null,
    { message: "no level" },
    { level: "info", message: "real" }
  ]);
  assert.equal(summary.verdict, "ok");
  assert.equal(summary.counts.info, 1);
  assert.ok(summary.notes.includes("invalid-event: 3 event(s) ignored"), summary.notes.join(" | "));
});

// ---------------------------------------------------------------------------
// 端到端：parseLogLines → summarizeEvents
// ---------------------------------------------------------------------------

test("parseLogLines output feeds summarizeEvents end to end", () => {
  const text = [
    "<3>EXT4-fs error on /dev/sda1 at 0x1f",
    "<3>EXT4-fs error on /dev/sda2 at 0x2f",
    "kern.warning: thermal zone 0 above threshold",
    "Oct 24 01:02:03 nas sshd[123]: Accepted publickey",
    "err: service trim refused to start"
  ].join("\n");
  const parsed = parseLogLines(text);
  const summary = summarizeEvents(parsed);

  assert.equal(parsed.dropped, 0);
  assert.equal(summary.verdict, "warning");
  assert.equal(summary.counts.err, 3);
  assert.equal(summary.counts.warning, 1);
  assert.equal(summary.counts.notice, 1);
  assert.equal(summary.repeated.length, 4);
  assert.deepEqual(summary.repeated[0], {
    normalized: "ext4-fs error on <path> at <hex>",
    count: 2,
    firstSample: "EXT4-fs error on /dev/sda1 at 0x1f",
    level: "err"
  });
});

// ---------------------------------------------------------------------------
// 安全边界：本模块是纯函数层
// ---------------------------------------------------------------------------

test("system-events.mjs stays dependency-free: no imports, no fs/process/network I/O", async () => {
  const source = await readFile(MODULE_PATH, "utf8");
  assert.equal(/^\s*import\s/m.test(source), false, "module must not import anything");
  assert.equal(/require\s*\(/.test(source), false, "module must not require anything");
  for (const specifier of ["node:fs", "node:child_process", "node:http", "node:net", "node:dns", "node:os", "node:path"]) {
    assert.equal(source.includes(specifier), false, `module must not reference ${specifier}`);
  }
  assert.equal(/(?:^|\W)child_process\s*\.|execSync|spawnSync/.test(source), false);
});

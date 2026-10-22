import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  DEFAULT_UPDATE_CHANNEL,
  UPDATE_CHANNELS,
  UPDATE_NOTES,
  UPDATE_STATUSES,
  VERSION_PATTERN,
  buildUpdateVerdict,
  compareVersions,
  isNewerAvailable,
  parseManifestVersion,
  parseVersion
} from "../apps/fnos-nas-agent/app/update-check.mjs";

const MODULE_PATH = new URL("../apps/fnos-nas-agent/app/update-check.mjs", import.meta.url);

// ---------------------------------------------------------------------------
// VERSION_PATTERN
// ---------------------------------------------------------------------------

test("VERSION_PATTERN matches x.y.z with optional pre-release and build metadata", () => {
  assert.ok(VERSION_PATTERN instanceof RegExp);
  assert.equal(VERSION_PATTERN.global, false);
  for (const text of [
    "0.0.0",
    "1.2.3",
    "10.20.30",
    "1.2.3-alpha",
    "1.2.3-alpha.1",
    "1.2.3-alpha.beta.1",
    "1.2.3-0",
    "1.2.3-x-y.7z",
    "1.2.3+build.5",
    "1.2.3+build.01",
    "1.2.3-rc.1+build.7"
  ]) {
    assert.equal(VERSION_PATTERN.test(text), true, `expected ${text} to match`);
  }

  // 捕获组顺序：major, minor, patch, pre, build。
  assert.deepEqual(VERSION_PATTERN.exec("1.2.3-rc.1+build.7").slice(1), ["1", "2", "3", "rc.1", "build.7"]);
  assert.deepEqual(VERSION_PATTERN.exec("1.2.3").slice(1), ["1", "2", "3", undefined, undefined]);
});

test("VERSION_PATTERN rejects non-canonical strings, empty segments and malformed identifiers", () => {
  for (const text of [
    "v1.2.3",
    " 1.2.3",
    "1.2.3 ",
    "1.2",
    "1.2.3.4",
    "1.2.x",
    "1..3",
    ".1.2",
    "1.2.3-",
    "1.2.3+",
    "1.2.3-rc..1",
    "1.2.3-rc.",
    "1.2.3+meta..1",
    "1.2.3+a+b",
    "1.2.3-rc_1",
    "1.2.3-rc 1",
    "01.2.3",
    "1.2.3-01",
    ""
  ]) {
    assert.equal(VERSION_PATTERN.test(text), false, `expected ${text} not to match`);
  }
});

// ---------------------------------------------------------------------------
// parseVersion
// ---------------------------------------------------------------------------

test("parseVersion returns major/minor/patch/pre/build/raw", () => {
  assert.deepEqual(parseVersion("1.2.3"), {
    major: 1,
    minor: 2,
    patch: 3,
    pre: null,
    build: null,
    raw: "1.2.3"
  });
  const pre = parseVersion("2.0.0-rc.1");
  assert.equal(pre.pre, "rc.1");
  assert.equal(pre.build, null);
  const build = parseVersion("0.2.1+build.2026");
  assert.equal(build.pre, null);
  assert.equal(build.build, "build.2026");
  const both = parseVersion("1.2.3-alpha.1+build.7");
  assert.deepEqual([both.major, both.minor, both.patch, both.pre, both.build], [1, 2, 3, "alpha.1", "build.7"]);
});

test("parseVersion trims whitespace, accepts a v prefix, and keeps raw verbatim", () => {
  const spaced = parseVersion("  v1.2.3-rc.1+build.7 \t");
  assert.equal(spaced.major, 1);
  assert.equal(spaced.pre, "rc.1");
  assert.equal(spaced.build, "build.7");
  assert.equal(spaced.raw, "  v1.2.3-rc.1+build.7 \t");

  const upper = parseVersion("V2.0.0");
  assert.equal(upper.major, 2);
  assert.equal(upper.raw, "V2.0.0");

  assert.equal(parseVersion("\n1.2.3\n").major, 1);
  // v 只在后面紧跟数字时剥离。
  assert.equal(parseVersion("version1.2.3"), null);
  assert.equal(parseVersion("v 1.2.3"), null);
  assert.equal(parseVersion("v"), null);
});

test("parseVersion returns null for non-string input", () => {
  for (const value of [undefined, null, 42, 1.2, true, {}, [], () => "1.2.3", Symbol("1.2.3")]) {
    assert.equal(parseVersion(value), null, `expected ${String(value)} to be rejected`);
  }
});

test("parseVersion returns null for malformed versions", () => {
  for (const text of [
    "",
    "   ",
    "\t\n",
    "1",
    "1.2",
    "1.2.3.4",
    "1.2.x",
    "x.y.z",
    "1.-2.3",
    "1.2.3-",
    "1.2.3+",
    "1.2.3-+",
    "1.2.3 alpha",
    "1.2.3-rc 1",
    " 1.2 .3"
  ]) {
    assert.equal(parseVersion(text), null, `expected ${JSON.stringify(text)} to be rejected`);
  }
});

test("parseVersion rejects numeric segments with leading zeros (SemVer 2.0.0)", () => {
  for (const text of ["01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "1.2.3-rc.01"]) {
    assert.equal(parseVersion(text), null, `expected ${text} to be rejected`);
  }
  // 0 本身合法；build 元数据允许前导零。
  assert.equal(parseVersion("0.0.0-0+build.01").build, "build.01");
});

test("parseVersion rejects numeric segments that exceed the safe integer range", () => {
  assert.equal(parseVersion("9007199254740992.0.0"), null);
  assert.equal(parseVersion("999999999999999999999.0.0"), null);
  const max = parseVersion("9007199254740991.0.0");
  assert.equal(max.major, Number.MAX_SAFE_INTEGER);
});

// ---------------------------------------------------------------------------
// compareVersions
// ---------------------------------------------------------------------------

test("compareVersions orders major/minor/patch numerically", () => {
  assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
  assert.equal(compareVersions("1.2.4", "1.2.3"), 1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("10.0.0", "9.9.9"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("compareVersions ignores build metadata and tolerates whitespace/v prefixes", () => {
  assert.equal(compareVersions("1.2.3+alpha", "1.2.3+beta"), 0);
  assert.equal(compareVersions("1.2.3", "1.2.3+001"), 0);
  assert.equal(compareVersions("1.2.3-rc.1+a", "1.2.3-rc.1+b"), 0);
  assert.equal(compareVersions(" v1.2.3 ", "V1.2.3"), 0);
});

test("compareVersions ranks a pre-release below the same release", () => {
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-alpha"), 1);
  assert.equal(compareVersions("2.0.0-rc.1", "2.0.0"), -1);
  assert.equal(compareVersions("0.2.1", "0.2.1-0"), 1);
});

test("compareVersions compares pre-release identifiers by number, text and segment count", () => {
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-alpha"), 1);
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.2"), -1);
  assert.equal(compareVersions("1.0.0-alpha.9", "1.0.0-alpha.10"), -1);
  assert.equal(compareVersions("1.0.0-1", "1.0.0-2"), -1);
  assert.equal(compareVersions("1.0.0-2", "1.0.0-10"), -1);
  // 数字段低于字母段。
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-1"), 1);
  // 字母段按 ASCII 码元序（大写在小写前）。
  assert.equal(compareVersions("1.0.0-Alpha", "1.0.0-alpha"), -1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.2"), 0);
});

test("compareVersions compares very large pre-release numbers without losing precision", () => {
  assert.equal(compareVersions("1.0.0-99999999999999999999", "1.0.0-100000000000000000000"), -1);
  assert.equal(compareVersions("1.0.0-100000000000000000000", "1.0.0-99999999999999999999"), 1);
});

test("compareVersions throws TypeError when either side is invalid", () => {
  assert.throws(() => compareVersions("1.2.3", "1.2"), TypeError);
  assert.throws(() => compareVersions("1.2", "1.2.3"), TypeError);
  assert.throws(() => compareVersions("1.2.3-01", "1.2.3"), TypeError);
  assert.throws(() => compareVersions(null, "1.2.3"), TypeError);
  assert.throws(() => compareVersions("1.2.3", undefined), TypeError);
  assert.throws(() => compareVersions({ major: 1, minor: 2, patch: 3 }, "1.2.3"), TypeError);
  assert.throws(() => compareVersions(), TypeError);
  assert.throws(() => compareVersions("1.2.3", "1.2"), /valid semantic versions/);
});

// ---------------------------------------------------------------------------
// isNewerAvailable
// ---------------------------------------------------------------------------

test("isNewerAvailable returns true only when latest is strictly newer", () => {
  assert.equal(isNewerAvailable({ current: "1.2.3", latest: "1.2.4" }), true);
  assert.equal(isNewerAvailable({ current: "1.2.3", latest: "1.3.0" }), true);
  assert.equal(isNewerAvailable({ current: "1.9.9", latest: "2.0.0" }), true);
  assert.equal(isNewerAvailable({ current: " v1.2.3 ", latest: "v1.2.4" }), true);
});

test("isNewerAvailable returns false for equal, older, build-only and invalid input", () => {
  assert.equal(isNewerAvailable({ current: "1.2.3", latest: "1.2.3" }), false);
  assert.equal(isNewerAvailable({ current: "1.2.3", latest: "1.2.3+build.2" }), false);
  assert.equal(isNewerAvailable({ current: "1.3.0", latest: "1.2.9" }), false);
  assert.equal(isNewerAvailable({ current: "1.2.3", latest: "1.2" }), false);
  assert.equal(isNewerAvailable({ current: "nope", latest: "1.2.4" }), false);
  assert.equal(isNewerAvailable({ current: "1.2.3" }), false);
  assert.equal(isNewerAvailable({}), false);
  assert.equal(isNewerAvailable(), false);
  assert.equal(isNewerAvailable(null), false);
  assert.equal(isNewerAvailable("1.2.3"), false);
  assert.equal(isNewerAvailable(42), false);
});

test("isNewerAvailable respects pre-release ordering", () => {
  assert.equal(isNewerAvailable({ current: "1.2.3-rc.1", latest: "1.2.3" }), true);
  assert.equal(isNewerAvailable({ current: "1.2.3", latest: "1.2.3-rc.1" }), false);
  assert.equal(isNewerAvailable({ current: "1.2.3-alpha", latest: "1.2.3-beta" }), true);
  assert.equal(isNewerAvailable({ current: "1.2.3-beta", latest: "1.2.3-beta" }), false);
});

// ---------------------------------------------------------------------------
// parseManifestVersion
// ---------------------------------------------------------------------------

test("parseManifestVersion reads a flat manifest and a one-level nested manifest", () => {
  const flat = parseManifestVersion(JSON.stringify({ appname: "trim", version: "0.2.1" }));
  assert.equal(flat.major, 0);
  assert.equal(flat.minor, 2);
  assert.equal(flat.patch, 1);
  assert.equal(flat.raw, "0.2.1");

  const nested = parseManifestVersion(JSON.stringify({
    appname: "trim",
    manifest: { name: "trim", version: " 1.4.0 " }
  }));
  assert.equal(nested.major, 1);
  assert.equal(nested.raw, " 1.4.0 ");

  // 根上的 version 优先于任意一层嵌套。
  const priority = parseManifestVersion(JSON.stringify({
    version: "1.2.3",
    meta: { version: "9.9.9" }
  }));
  assert.deepEqual([priority.major, priority.minor, priority.patch], [1, 2, 3]);
});

test("parseManifestVersion also accepts an already-parsed object", () => {
  assert.equal(parseManifestVersion({ version: "1.2.3" }).patch, 3);
  assert.equal(parseManifestVersion({ app: { version: "2.0.0" } }).major, 2);
  assert.equal(parseManifestVersion(null), null);
  assert.equal(parseManifestVersion(42), null);
});

test("parseManifestVersion returns null for invalid JSON, missing fields and invalid versions", () => {
  for (const input of [
    "{",
    "not json",
    "",
    "   ",
    "[]",
    "null",
    JSON.stringify("1.2.3"),
    JSON.stringify({ name: "trim" }),
    JSON.stringify({ version: "1.2" }),
    JSON.stringify({ version: 42 }),
    JSON.stringify({ version: null }),
    JSON.stringify({ app: { name: "trim" } })
  ]) {
    assert.equal(parseManifestVersion(input), null, `expected ${input} to be rejected`);
  }
});

test("parseManifestVersion only looks one level deep and rejects ambiguous nesting", () => {
  // 两层嵌套不在契约内。
  assert.equal(parseManifestVersion({ a: { b: { version: "1.2.3" } } }), null);
  // 数组根不是普通对象。
  assert.equal(parseManifestVersion([{ version: "1.2.3" }]), null);
  // 两个子对象给出不同版本 → 歧义，不猜。
  assert.equal(parseManifestVersion({ a: { version: "1.2.3" }, b: { version: "1.2.4" } }), null);
  // 两个子对象给出同一个版本（写法不同也算同一版本）→ 不歧义。
  const same = parseManifestVersion({ a: { version: "1.2.3" }, b: { version: "v1.2.3" } });
  assert.equal(same.major, 1);
  assert.equal(same.raw, "1.2.3");
});

// ---------------------------------------------------------------------------
// buildUpdateVerdict
// ---------------------------------------------------------------------------

test("buildUpdateVerdict reports up-to-date when versions are equal", () => {
  const verdict = buildUpdateVerdict({ current: "1.2.3", latest: "1.2.3" });
  assert.deepEqual(verdict, {
    status: "up-to-date",
    current: "1.2.3",
    latest: "1.2.3",
    channel: "stable",
    notes: []
  });

  // build 元数据不参与比较，因此只差 build 仍是 up-to-date。
  const buildOnly = buildUpdateVerdict({ current: "1.2.3+build.1", latest: "1.2.3+build.2" });
  assert.equal(buildOnly.status, "up-to-date");
  assert.deepEqual(buildOnly.notes, []);
});

test("buildUpdateVerdict reports update-available when latest is newer", () => {
  const verdict = buildUpdateVerdict({ current: "0.2.1", latest: "0.3.0" });
  assert.equal(verdict.status, "update-available");
  assert.deepEqual(verdict.notes, []);
  assert.equal(verdict.current, "0.2.1");
  assert.equal(verdict.latest, "0.3.0");

  const preToRelease = buildUpdateVerdict({ current: "1.2.3-rc.1", latest: "1.2.3" });
  assert.equal(preToRelease.status, "update-available");
});

test("buildUpdateVerdict refuses to offer a downgrade and says so in notes", () => {
  const verdict = buildUpdateVerdict({ current: "2.0.0", latest: "1.9.9" });
  assert.equal(verdict.status, "unknown");
  assert.deepEqual(verdict.notes, [UPDATE_NOTES.DOWNGRADE_NOT_OFFERED]);
  assert.equal(verdict.current, "2.0.0");
  assert.equal(verdict.latest, "1.9.9");

  const preDowngrade = buildUpdateVerdict({ current: "1.2.3", latest: "1.2.3-rc.1" });
  assert.equal(preDowngrade.status, "unknown");
  assert.deepEqual(preDowngrade.notes, ["downgrade-not-offered"]);
});

test("buildUpdateVerdict returns unknown with reasons for invalid or missing sides", () => {
  const invalidCurrent = buildUpdateVerdict({ current: "1.2", latest: "1.3.0" });
  assert.equal(invalidCurrent.status, "unknown");
  assert.deepEqual(invalidCurrent.notes, [UPDATE_NOTES.CURRENT_INVALID]);

  const invalidLatest = buildUpdateVerdict({ current: "1.2.3", latest: "not-a-version" });
  assert.equal(invalidLatest.status, "unknown");
  assert.deepEqual(invalidLatest.notes, [UPDATE_NOTES.LATEST_INVALID]);

  const bothMissing = buildUpdateVerdict({});
  assert.equal(bothMissing.status, "unknown");
  assert.deepEqual(bothMissing.notes, [UPDATE_NOTES.CURRENT_MISSING, UPDATE_NOTES.LATEST_MISSING]);

  const emptyStrings = buildUpdateVerdict({ current: "   ", latest: "" });
  assert.equal(emptyStrings.status, "unknown");
  assert.deepEqual(emptyStrings.notes, ["current-missing", "latest-missing"]);

  const bothInvalid = buildUpdateVerdict({ current: "1.2.3-01", latest: "01.0.0" });
  assert.equal(bothInvalid.status, "unknown");
  assert.deepEqual(bothInvalid.notes, ["current-invalid", "latest-invalid"]);
});

test("buildUpdateVerdict echoes string inputs verbatim and null for non-strings", () => {
  const invalid = buildUpdateVerdict({ current: " 1.2 ", latest: "1.3.0" });
  assert.equal(invalid.current, " 1.2 ");
  assert.equal(invalid.latest, "1.3.0");

  const mixed = buildUpdateVerdict({ current: 42, latest: null });
  assert.equal(mixed.current, null);
  assert.equal(mixed.latest, null);
  assert.deepEqual(mixed.notes, ["current-invalid", "latest-missing"]);
});

test("buildUpdateVerdict validates and echoes the channel without changing the comparison", () => {
  assert.deepEqual(UPDATE_CHANNELS, ["stable", "beta", "any"]);
  assert.equal(DEFAULT_UPDATE_CHANNEL, "stable");

  assert.equal(buildUpdateVerdict({ current: "1.0.0", latest: "1.1.0" }).channel, "stable");
  for (const channel of ["beta", "any"]) {
    const verdict = buildUpdateVerdict({ current: "1.1.0", latest: "1.0.0", channel });
    assert.equal(verdict.channel, channel);
    assert.equal(verdict.status, "unknown");
    assert.deepEqual(verdict.notes, ["downgrade-not-offered"]);
  }
  for (const channel of ["Stable", "nightly", "", null, 1, true]) {
    assert.throws(
      () => buildUpdateVerdict({ current: "1.0.0", latest: "1.1.0", channel }),
      TypeError,
      `expected channel ${String(channel)} to be rejected`
    );
  }
});

test("buildUpdateVerdict throws TypeError for a non-object options argument", () => {
  for (const options of [null, 42, "v1.2.3", true]) {
    assert.throws(() => buildUpdateVerdict(options), TypeError);
  }
  const empty = buildUpdateVerdict();
  assert.equal(empty.status, "unknown");
  assert.deepEqual(empty.notes, ["current-missing", "latest-missing"]);
  assert.equal(empty.channel, "stable");
});

test("buildUpdateVerdict never reports unknown as up-to-date", () => {
  const badValues = ["", "   ", "nope", "1.2", "01.2.3", "1.2.3-01", null, undefined, 42];
  for (const value of badValues) {
    const currentSide = buildUpdateVerdict({ current: value, latest: "1.2.3" });
    assert.equal(currentSide.status, "unknown", `current=${String(value)} must stay unknown`);
    assert.notEqual(currentSide.status, "up-to-date");
    assert.ok(currentSide.notes.length > 0);

    const latestSide = buildUpdateVerdict({ current: "1.2.3", latest: value });
    assert.equal(latestSide.status, "unknown", `latest=${String(value)} must stay unknown`);
    assert.notEqual(latestSide.status, "up-to-date");
    assert.ok(latestSide.notes.length > 0);
  }
});

test("exported status and note constants stay stable", () => {
  assert.deepEqual(UPDATE_STATUSES, {
    UP_TO_DATE: "up-to-date",
    UPDATE_AVAILABLE: "update-available",
    UNKNOWN: "unknown"
  });
  assert.deepEqual(UPDATE_NOTES, {
    CURRENT_MISSING: "current-missing",
    CURRENT_INVALID: "current-invalid",
    LATEST_MISSING: "latest-missing",
    LATEST_INVALID: "latest-invalid",
    DOWNGRADE_NOT_OFFERED: "downgrade-not-offered"
  });
});

// ---------------------------------------------------------------------------
// 安全边界：本模块是纯函数层
// ---------------------------------------------------------------------------

test("update-check.mjs stays pure: no imports and no fs/process/network I/O", async () => {
  const source = await readFile(MODULE_PATH, "utf8");
  assert.equal(/^\s*import\s/m.test(source), false, "module must not import anything");
  assert.equal(/\brequire\s*\(/.test(source), false, "module must not require anything");
  assert.equal(source.includes("node:"), false, "module must not reference any node: specifier");
  for (const specifier of ["node:fs", "node:child_process", "node:http", "node:https", "node:net", "node:dns", "node:os", "node:path"]) {
    assert.equal(source.includes(specifier), false, `module must not reference ${specifier}`);
  }
  assert.equal(/\b(?:fetch|XMLHttpRequest)\s*\(/.test(source), false, "module must not perform network calls");
  assert.equal(/\bprocess\s*\./.test(source), false, "module must not read process state");
});

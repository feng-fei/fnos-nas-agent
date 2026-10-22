import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  CERT_NOTES,
  CERT_VERDICTS,
  DEFAULT_WARN_DAYS,
  MAX_SAN_ENTRIES,
  daysUntilExpiry,
  matchesHostname,
  parseCertificateRecord,
  summarizeCertificate
} from "../apps/fnos-nas-agent/app/certificate-check.mjs";

const MODULE_PATH = new URL("../apps/fnos-nas-agent/app/certificate-check.mjs", import.meta.url);

/** 固定的「现在」，让所有断言与时区、系统时钟无关。 */
const NOW = "2026-01-01T00:00:00.000Z";

const FAR_FUTURE = "2026-12-31T00:00:00.000Z";
const LONG_AGO = "2025-01-01T00:00:00.000Z";

/**
 * 一张「健康」证书的采集记录：一年有效期、SAN 与主机名一致。
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function makeRecord(overrides = {}) {
  return {
    subject: "CN=nas.example.com",
    issuer: "CN=Example CA",
    notBefore: LONG_AGO,
    notAfter: FAR_FUTURE,
    san: ["DNS:nas.example.com"],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// parseCertificateRecord
// ---------------------------------------------------------------------------

test("parseCertificateRecord normalizes ISO strings and epoch milliseconds to the same record", () => {
  const iso = parseCertificateRecord({
    subject: "CN=nas.example.com",
    issuer: "CN=Example CA",
    notBefore: LONG_AGO,
    notAfter: FAR_FUTURE,
    san: ["DNS:nas.example.com"]
  });
  const epoch = parseCertificateRecord({
    subject: "CN=nas.example.com",
    issuer: "CN=Example CA",
    notBefore: Date.UTC(2025, 0, 1),
    notAfter: Date.UTC(2026, 11, 31),
    san: ["DNS:nas.example.com"]
  });

  assert.deepEqual(iso, {
    subject: "CN=nas.example.com",
    issuer: "CN=Example CA",
    notBefore: "2025-01-01T00:00:00.000Z",
    notAfter: "2026-12-31T00:00:00.000Z",
    san: ["DNS:nas.example.com"],
    parsed: true
  });
  assert.deepEqual(epoch, iso);

  // 归一结果再喂进来必须得到同一份记录（幂等），调用方可以放心复用。
  const again = parseCertificateRecord(iso);
  assert.deepEqual(again, iso);
  assert.deepEqual(parseCertificateRecord(again), iso);
});

test("parseCertificateRecord canonicalizes SAN types and keeps non-hostname SANs for audit", () => {
  const record = parseCertificateRecord({
    san: [
      "DNS:a.example.com",
      "IP Address:10.0.0.1",
      "10.0.0.9",
      "dns:b.example.com",
      { type: "dNSName", value: "c.example.com" },
      { type: "IP Address", value: "192.0.2.7" },
      "email:ops@example.com",
      "URI:https://example.com/x",
      "DirName:/C=CN/O=Example"
    ]
  });

  assert.deepEqual(record.san, [
    "DNS:a.example.com",
    "IP Address:10.0.0.1",
    "IP Address:10.0.0.9",
    "DNS:b.example.com",
    "DNS:c.example.com",
    "IP Address:192.0.2.7",
    "email:ops@example.com",
    "URI:https://example.com/x",
    "DirName:/C=CN/O=Example"
  ]);
  assert.equal(record.parsed, true);
});

test("parseCertificateRecord treats blank fields as missing and separates missing from invalid", () => {
  assert.deepEqual(parseCertificateRecord({}), {
    subject: null,
    issuer: null,
    notBefore: null,
    notAfter: null,
    san: [],
    parsed: true
  });

  // 空白 = 没给（parsed 仍为 true）；只有「给了但读不懂」才把 parsed 打成 false。
  const blank = parseCertificateRecord({
    subject: "   ",
    issuer: "",
    notBefore: "  ",
    notAfter: ""
  });
  assert.equal(blank.subject, null);
  assert.equal(blank.issuer, null);
  assert.equal(blank.notBefore, null);
  assert.equal(blank.notAfter, null);
  assert.equal(blank.parsed, true);

  const unreadable = parseCertificateRecord({
    subject: 42,
    issuer: { CN: "Example CA" },
    notAfter: "not-a-date"
  });
  assert.equal(unreadable.subject, null);
  assert.equal(unreadable.issuer, null);
  assert.equal(unreadable.notAfter, null);
  assert.equal(unreadable.parsed, false);
});

test("parseCertificateRecord rejects timestamps that would need a guess", () => {
  for (const notAfter of [
    "not-a-date",
    "Jan  1 00:00:00 2026 GMT",
    "2026-02-30T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T00:60:00Z",
    "2026-01-01T00:00:00",
    "01/02/2026",
    "20260101",
    "1735689600000",
    new Date(FAR_FUTURE),
    true
  ]) {
    const record = parseCertificateRecord({ notAfter });
    assert.equal(record.notAfter, null, `expected ${String(notAfter)} to be rejected`);
    assert.equal(record.parsed, false, `expected ${String(notAfter)} to be flagged as unparsed`);
  }
});

test("parseCertificateRecord accepts ISO offsets, fractions and date-only forms as UTC", () => {
  assert.equal(
    parseCertificateRecord({ notAfter: "2026-01-01T08:00:00+08:00" }).notAfter,
    "2026-01-01T00:00:00.000Z"
  );
  assert.equal(
    parseCertificateRecord({ notAfter: "2026-01-01T00:00:00.123456Z" }).notAfter,
    "2026-01-01T00:00:00.123Z"
  );
  assert.equal(
    parseCertificateRecord({ notAfter: "2026-01-01T00:00:00-05:30" }).notAfter,
    "2026-01-01T05:30:00.000Z"
  );
  assert.equal(
    parseCertificateRecord({ notAfter: "2026-01-01" }).notAfter,
    "2026-01-01T00:00:00.000Z"
  );
  assert.equal(
    parseCertificateRecord({ notAfter: " 2026-01-01T00:00:00Z " }).notAfter,
    "2026-01-01T00:00:00.000Z"
  );
});

test("parseCertificateRecord returns null for shapes that cannot be read at all", () => {
  for (const input of [undefined, null, "CN=nas.example.com", 42, true, [], ["DNS:a"]]) {
    assert.equal(parseCertificateRecord(input), null, `expected ${String(input)} to be rejected`);
  }

  // SAN 不是数组、或含无法识别的条目 → 整条记录不可用（无法证明「名字不在证书里」）。
  assert.equal(parseCertificateRecord({ san: "DNS:a.example.com, IP Address:10.0.0.1" }), null);
  assert.equal(parseCertificateRecord({ san: [42] }), null);
  assert.equal(parseCertificateRecord({ san: [null] }), null);
  assert.equal(parseCertificateRecord({ san: [{ value: "a.example.com" }] }), null);
  assert.equal(parseCertificateRecord({ san: [{ type: "DNS" }] }), null);

  // 空白 SAN 条目没有信息量，跳过。
  assert.deepEqual(parseCertificateRecord({ san: ["", "  ", "DNS:a.example.com"] }).san, [
    "DNS:a.example.com"
  ]);
});

test("parseCertificateRecord caps the SAN list at MAX_SAN_ENTRIES", () => {
  assert.equal(MAX_SAN_ENTRIES, 50);
  const entries = Array.from({ length: MAX_SAN_ENTRIES + 10 }, (_, index) => `DNS:h${index}.example.com`);
  const record = parseCertificateRecord({ san: entries });
  assert.equal(record.san.length, MAX_SAN_ENTRIES);
  assert.equal(record.san[0], "DNS:h0.example.com");
  assert.equal(record.san[MAX_SAN_ENTRIES - 1], "DNS:h49.example.com");
});

// ---------------------------------------------------------------------------
// daysUntilExpiry
// ---------------------------------------------------------------------------

test("daysUntilExpiry floors to whole days and goes negative once expired", () => {
  assert.equal(daysUntilExpiry("2026-01-31T00:00:00.000Z", NOW), 30);
  assert.equal(daysUntilExpiry("2026-01-02T00:00:00.000Z", NOW), 1);
  assert.equal(daysUntilExpiry("2026-01-01T12:00:00.000Z", NOW), 0);
  assert.equal(daysUntilExpiry(NOW, NOW), 0);
  assert.equal(daysUntilExpiry("2025-12-31T12:00:00.000Z", NOW), -1);
  assert.equal(daysUntilExpiry("2025-12-30T00:00:00.000Z", NOW), -2);
});

test("daysUntilExpiry accepts epoch milliseconds on both sides and returns null on garbage", () => {
  assert.equal(daysUntilExpiry(Date.UTC(2026, 0, 31), Date.UTC(2026, 0, 1)), 30);
  assert.equal(daysUntilExpiry(Date.UTC(2026, 0, 31), NOW), 30);
  assert.equal(daysUntilExpiry("2026-01-31T00:00:00.000Z", Date.UTC(2026, 0, 1)), 30);

  // 数字一律按 epoch 毫秒读，不做「这看起来像 yyyymmdd」的猜测。
  assert.equal(daysUntilExpiry(20260101, NOW), -20454);

  for (const notAfter of [null, undefined, "", "nope", true, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(daysUntilExpiry(notAfter, NOW), null, `expected notAfter ${String(notAfter)} to be rejected`);
  }
  for (const now of [null, "", "nope", Number.NaN, true, {}]) {
    assert.equal(daysUntilExpiry(FAR_FUTURE, now), null, `expected now ${String(now)} to be rejected`);
  }
});

// ---------------------------------------------------------------------------
// matchesHostname
// ---------------------------------------------------------------------------

test("matchesHostname prefers dNSName SANs and only wildcards the leftmost label", () => {
  const wildcard = { san: ["DNS:*.example.com"] };
  assert.equal(matchesHostname(wildcard, "a.example.com"), true);
  assert.equal(matchesHostname(wildcard, "example.com"), false);
  assert.equal(matchesHostname(wildcard, "a.b.example.com"), false);
  assert.equal(matchesHostname(wildcard, "badexample.com"), false);
  assert.equal(matchesHostname(wildcard, "a.example.com."), true);

  const exact = { san: ["DNS:example.com"] };
  assert.equal(matchesHostname(exact, "example.com"), true);
  assert.equal(matchesHostname(exact, "www.example.com"), false);

  // 通配符出现在非最左段、或不是 `*.` 形态 → 不是合法模式，永不匹配。
  for (const san of ["DNS:a.*.com", "DNS:*", "DNS:*example.com"]) {
    assert.equal(matchesHostname({ san: [san] }, "a.b.com"), false, `expected ${san} not to match`);
    assert.equal(matchesHostname({ san: [san] }, "example.com"), false, `expected ${san} not to match`);
  }

  // 多个 SAN 里任意一条命中即可。
  assert.equal(
    matchesHostname({ san: ["DNS:one.example.com", "DNS:two.example.com"] }, "two.example.com"),
    true
  );
});

test("matchesHostname is case-insensitive on both sides", () => {
  assert.equal(matchesHostname({ san: ["DNS:NAS.Example.COM"] }, "nas.example.com"), true);
  assert.equal(matchesHostname({ san: ["DNS:nas.example.com"] }, "NAS.EXAMPLE.COM"), true);
  assert.equal(matchesHostname({ subject: "CN=NAS.LOCAL" }, "nas.local"), true);
  assert.equal(matchesHostname({ san: ["DNS:*.Example.COM"] }, "A.example.com"), true);
});

test("matchesHostname falls back to the subject CN only when no dNSName SAN exists", () => {
  assert.equal(matchesHostname({ subject: "CN=nas.local" }, "nas.local"), true);
  assert.equal(matchesHostname({ subject: "CN=*.nas.local" }, "a.nas.local"), true);
  assert.equal(matchesHostname({ subject: "CN=*.nas.local" }, "nas.local"), false);
  // 裸值（DN 里没有 `=`）整体就是 CN。
  assert.equal(matchesHostname({ subject: "nas.local" }, "nas.local"), true);
  // DN 里有 CN 组件时按 DN 取，不被其它 RDN 干扰。
  assert.equal(matchesHostname({ subject: "O=Example, CN=nas.local, C=CN" }, "nas.local"), true);

  // 存在 dNSName 之后不再看 CN。
  assert.equal(matchesHostname({ subject: "CN=nas.local", san: ["DNS:other.local"] }, "nas.local"), false);
  // 只有非 dNSName 类型的 SAN 时仍允许回落 CN。
  assert.equal(
    matchesHostname({ subject: "CN=example.com", san: ["email:ops@example.com"] }, "example.com"),
    true
  );

  // 既没有 dNSName 也没有 CN → 信息不足，不猜。
  assert.equal(matchesHostname({ subject: "O=OnlyOrg" }, "nas.local"), null);
  assert.equal(matchesHostname({ subject: null }, "nas.local"), null);
  assert.equal(matchesHostname({}, "nas.local"), null);
});

test("matchesHostname matches IP literals only against iPAddress SANs", () => {
  assert.equal(matchesHostname({ san: ["IP Address:10.0.0.5"] }, "10.0.0.5"), true);
  assert.equal(matchesHostname({ san: ["10.0.0.5"] }, "10.0.0.5"), true);
  assert.equal(matchesHostname({ san: ["IP Address:10.0.0.5"] }, "10.0.0.6"), false);
  // DNS 类型里的 IP 字符串不是地址证据。
  assert.equal(matchesHostname({ san: ["DNS:10.0.0.5"] }, "10.0.0.5"), false);
  // IP 主机名不回落 CN（现代客户端只认 iPAddress SAN）。
  assert.equal(matchesHostname({ subject: "CN=10.0.0.5" }, "10.0.0.5"), false);
});

test("matchesHostname returns null for invalid hostnames and unreadable records", () => {
  const record = { subject: "CN=nas.local", san: ["DNS:nas.local"] };
  for (const hostname of [
    undefined,
    null,
    "",
    "   ",
    "nas local",
    "nas..local",
    "-bad.local",
    "bad-.local",
    "*.nas.local",
    "2001:db8::1",
    `${"a".repeat(64)}.local`,
    42,
    true
  ]) {
    assert.equal(matchesHostname(record, hostname), null, `expected ${String(hostname)} to be rejected`);
  }

  assert.equal(matchesHostname(null, "nas.local"), null);
  assert.equal(matchesHostname("CN=nas.local", "nas.local"), null);
  assert.equal(matchesHostname({ san: [42] }, "nas.local"), null);
});

test("matchesHostname stays silent when the SAN list may have been truncated", () => {
  const entries = Array.from({ length: MAX_SAN_ENTRIES }, (_, index) => `DNS:host${index}.example.com`);

  // 达到上限：列表可能被截断，因此无法证明「不在里面」，不给 false。
  assert.equal(matchesHostname({ san: entries }, "missing.example.com"), null);
  // 但命中仍在列表内的条目是肯定的事实。
  assert.equal(matchesHostname({ san: entries }, "host7.example.com"), true);

  // 少一条就没有截断，false 是可靠结论。
  const below = entries.slice(0, MAX_SAN_ENTRIES - 1);
  assert.equal(matchesHostname({ san: below }, "missing.example.com"), false);
});

// ---------------------------------------------------------------------------
// summarizeCertificate
// ---------------------------------------------------------------------------

test("summarizeCertificate reports ok, expiring and expired against a fixed now", () => {
  const ok = summarizeCertificate(makeRecord(), { now: NOW });
  assert.deepEqual(ok, {
    verdict: "ok",
    daysRemaining: 364,
    hostnameMatches: null,
    notes: ["hostname-not-checked"]
  });

  const expiring = summarizeCertificate(makeRecord({ notAfter: "2026-01-20T00:00:00.000Z" }), { now: NOW });
  assert.equal(expiring.verdict, CERT_VERDICTS.EXPIRING);
  assert.equal(expiring.daysRemaining, 19);
  assert.deepEqual(expiring.notes, ["expiring", "hostname-not-checked"]);

  // 边界：正好 warnDays 天算 expiring，多一天才算 ok。
  const boundary = summarizeCertificate(makeRecord({ notAfter: "2026-01-31T00:00:00.000Z" }), { now: NOW });
  assert.equal(boundary.daysRemaining, DEFAULT_WARN_DAYS);
  assert.equal(boundary.verdict, "expiring");

  const justOver = summarizeCertificate(makeRecord({ notAfter: "2026-02-01T00:00:00.000Z" }), { now: NOW });
  assert.equal(justOver.daysRemaining, 31);
  assert.equal(justOver.verdict, "ok");

  const expired = summarizeCertificate(makeRecord({ notAfter: "2025-12-31T00:00:00.000Z" }), { now: NOW });
  assert.equal(expired.verdict, "expired");
  assert.equal(expired.daysRemaining, -1);
  assert.deepEqual(expired.notes, ["expired", "hostname-not-checked"]);

  // 过期时刻等于 now：已过期，且剩余天数不为正。
  const justExpired = summarizeCertificate(makeRecord({ notAfter: NOW }), { now: NOW });
  assert.equal(justExpired.verdict, "expired");
  assert.equal(justExpired.daysRemaining, 0);
});

test("summarizeCertificate accepts ISO strings and epoch milliseconds interchangeably", () => {
  const iso = summarizeCertificate(makeRecord(), { now: NOW });
  const epoch = summarizeCertificate(
    makeRecord({
      notBefore: Date.UTC(2025, 0, 1),
      notAfter: Date.UTC(2026, 11, 31)
    }),
    { now: Date.UTC(2026, 0, 1) }
  );
  assert.deepEqual(epoch, iso);

  // 混用两种输入也成立。
  const mixed = summarizeCertificate(
    makeRecord({ notAfter: Date.UTC(2026, 0, 20) }),
    { now: NOW }
  );
  assert.equal(mixed.verdict, "expiring");
  assert.equal(mixed.daysRemaining, 19);
});

test("summarizeCertificate downgrades unreadable timestamps and inverted validity windows", () => {
  const unreadable = summarizeCertificate(makeRecord({ notAfter: "not-a-date" }), { now: NOW });
  assert.equal(unreadable.verdict, "invalid");
  assert.equal(unreadable.daysRemaining, null);
  assert.deepEqual(unreadable.notes, ["not-after-invalid", "hostname-not-checked"]);

  const badNotBefore = summarizeCertificate(makeRecord({ notBefore: "yesterday" }), { now: NOW });
  assert.equal(badNotBefore.verdict, "invalid");
  assert.deepEqual(badNotBefore.notes, ["not-before-invalid", "hostname-not-checked"]);

  const inverted = summarizeCertificate(
    makeRecord({ notBefore: "2027-01-01T00:00:00.000Z", notAfter: "2026-06-01T00:00:00.000Z" }),
    { now: NOW }
  );
  assert.equal(inverted.verdict, "invalid");
  assert.equal(inverted.daysRemaining, 151);
  assert.deepEqual(inverted.notes, ["range-invalid", "hostname-not-checked"]);

  // 采集层明确标 parsed:false 时，即使字段看起来能读也不放行。
  const collectorFailed = summarizeCertificate({ ...makeRecord(), parsed: false }, { now: NOW });
  assert.equal(collectorFailed.verdict, "invalid");
  assert.deepEqual(collectorFailed.notes, ["record-invalid", "hostname-not-checked"]);
});

test("summarizeCertificate never reports ok when nothing could be read", () => {
  const missing = summarizeCertificate(undefined, { now: NOW });
  assert.equal(missing.verdict, "unknown");
  assert.equal(missing.daysRemaining, null);
  assert.deepEqual(missing.notes, ["record-missing"]);

  for (const record of [null, "nope", 42, []]) {
    assert.equal(summarizeCertificate(record, { now: NOW }).verdict, "unknown");
  }

  const empty = summarizeCertificate({}, { now: NOW });
  assert.equal(empty.verdict, "unknown");
  assert.deepEqual(empty.notes, ["not-after-missing", "not-before-missing", "hostname-not-checked"]);

  const blank = summarizeCertificate({ notAfter: "   " }, { now: NOW });
  assert.equal(blank.verdict, "unknown");
  assert.ok(blank.notes.includes(CERT_NOTES.NOT_AFTER_MISSING));

  const unreadableSan = summarizeCertificate({ notAfter: FAR_FUTURE, san: [42] }, { now: NOW });
  assert.equal(unreadableSan.verdict, "unknown");
  assert.deepEqual(unreadableSan.notes, ["record-unreadable"]);

  // 非法 now 只说明「判不了」，不会冒充 ok。
  const badNow = summarizeCertificate(makeRecord(), { now: "someday" });
  assert.equal(badNow.verdict, "unknown");
  assert.equal(badNow.daysRemaining, null);
  assert.deepEqual(badNow.notes, ["now-invalid", "hostname-not-checked"]);

  // 本层不读系统时钟：不传 now 就是「没给基准」，结论只能是 unknown。
  const missingNow = summarizeCertificate(makeRecord());
  assert.equal(missingNow.verdict, "unknown");
  assert.equal(missingNow.daysRemaining, null);
  assert.deepEqual(missingNow.notes, ["now-missing", "hostname-not-checked"]);

  // 一张「没读到」的证书永远不能是 ok / expiring。
  for (const verdict of [missing.verdict, empty.verdict, unreadableSan.verdict, badNow.verdict]) {
    assert.notEqual(verdict, "ok");
    assert.notEqual(verdict, "expiring");
  }
});

test("summarizeCertificate only invalidates on a proven hostname mismatch", () => {
  const mismatched = summarizeCertificate(makeRecord(), { now: NOW, hostname: "other.example.com" });
  assert.equal(mismatched.verdict, "invalid");
  assert.equal(mismatched.hostnameMatches, false);
  assert.deepEqual(mismatched.notes, ["hostname-mismatch"]);

  // 已过期 + 名字也不对：notes 保留两个维度，结论取更硬的 invalid。
  const both = summarizeCertificate(makeRecord({ notAfter: "2025-12-31T00:00:00.000Z" }), {
    now: NOW,
    hostname: "other.example.com"
  });
  assert.equal(both.verdict, "invalid");
  assert.deepEqual(both.notes, ["expired", "hostname-mismatch"]);

  // 时间维度 unknown 时，已证实的名字不符仍然是硬失败。
  const unknownPlusMismatch = summarizeCertificate({ subject: "CN=nas.example.com" }, {
    now: NOW,
    hostname: "other.example.com"
  });
  assert.equal(unknownPlusMismatch.verdict, "invalid");
  assert.deepEqual(unknownPlusMismatch.notes, [
    "not-after-missing",
    "not-before-missing",
    "hostname-mismatch"
  ]);

  // 信息不足：只记 note，不改结论。
  const insufficient = summarizeCertificate({ subject: "O=OnlyOrg", notBefore: LONG_AGO, notAfter: FAR_FUTURE }, {
    now: NOW,
    hostname: "nas.example.com"
  });
  assert.equal(insufficient.verdict, "ok");
  assert.equal(insufficient.hostnameMatches, null);
  assert.deepEqual(insufficient.notes, ["hostname-unknown"]);

  // 调用方把主机名写错了：也是 null，而不是 false。
  const invalidHostname = summarizeCertificate(makeRecord(), { now: NOW, hostname: "bad host!" });
  assert.equal(invalidHostname.verdict, "ok");
  assert.equal(invalidHostname.hostnameMatches, null);
  assert.deepEqual(invalidHostname.notes, ["hostname-invalid"]);

  // 名字对得上时没有额外备注，结论不变。
  const matched = summarizeCertificate(makeRecord(), { now: NOW, hostname: "nas.example.com" });
  assert.equal(matched.verdict, "ok");
  assert.equal(matched.hostnameMatches, true);
  assert.deepEqual(matched.notes, []);
});

test("summarizeCertificate honors warnDays and rejects non-object options", () => {
  const tenDays = makeRecord({ notAfter: "2026-01-11T00:00:00.000Z" });
  assert.equal(summarizeCertificate(tenDays, { now: NOW, warnDays: 7 }).verdict, "ok");
  assert.equal(summarizeCertificate(tenDays, { now: NOW, warnDays: 10 }).verdict, "expiring");
  assert.equal(summarizeCertificate(tenDays, { now: NOW, warnDays: 90 }).verdict, "expiring");
  // 不传 warnDays 用默认值。
  assert.equal(summarizeCertificate(tenDays, { now: NOW }).verdict, "expiring");
  assert.equal(DEFAULT_WARN_DAYS, 30);

  for (const warnDays of [0, -1, -30, Number.NaN, Number.POSITIVE_INFINITY, "30", null, true, {}]) {
    assert.throws(
      () => summarizeCertificate(makeRecord(), { now: NOW, warnDays }),
      TypeError,
      `expected warnDays ${String(warnDays)} to be rejected`
    );
  }

  for (const options of [null, "now", 42, true]) {
    assert.throws(() => summarizeCertificate(makeRecord(), options), TypeError);
  }
});

test("summarizeCertificate notes are deduplicated, machine-readable and content-free", () => {
  const cases = [
    summarizeCertificate(makeRecord(), { now: NOW }),
    summarizeCertificate(makeRecord(), { now: NOW, hostname: "nas.example.com" }),
    summarizeCertificate(makeRecord(), { now: NOW, hostname: "other.example.com" }),
    summarizeCertificate(makeRecord({ notAfter: "2025-12-31T00:00:00.000Z" }), {
      now: NOW,
      hostname: "other.example.com"
    }),
    summarizeCertificate(makeRecord({ notAfter: "not-a-date", notBefore: "also-bad" }), { now: NOW }),
    summarizeCertificate({ san: [42] }, { now: NOW }),
    summarizeCertificate({}, { now: NOW }),
    summarizeCertificate(makeRecord(), { now: "someday", hostname: "bad host!" })
  ];

  // 「具体证书内容」不允许出现在备注里：这里用一张带标记的证书来验证。
  const marker = makeRecord({
    subject: "CN=secret-marker.internal",
    issuer: "CN=issuer-marker.internal",
    san: ["DNS:secret-marker.internal"]
  });
  const marked = [
    summarizeCertificate(marker, { now: NOW }),
    summarizeCertificate(marker, { now: NOW, hostname: "secret-marker.internal" }),
    summarizeCertificate(marker, { now: NOW, hostname: "nope.internal" })
  ];

  for (const result of [...cases, ...marked]) {
    assert.equal(new Set(result.notes).size, result.notes.length, "notes must not repeat");
    for (const note of result.notes) {
      assert.match(note, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, `note ${note} must be a stable identifier`);
      assert.equal(note.includes("secret-marker"), false);
      assert.equal(note.includes("issuer-marker"), false);
      assert.equal(note.includes(".internal"), false);
    }
    assert.equal(typeof result.verdict, "string");
    assert.ok(Object.values(CERT_VERDICTS).includes(result.verdict));
  }
});

test("exported constants stay stable and frozen", () => {
  assert.deepEqual(CERT_VERDICTS, {
    OK: "ok",
    EXPIRING: "expiring",
    EXPIRED: "expired",
    INVALID: "invalid",
    UNKNOWN: "unknown"
  });
  assert.deepEqual(CERT_NOTES, {
    RECORD_MISSING: "record-missing",
    RECORD_UNREADABLE: "record-unreadable",
    RECORD_INVALID: "record-invalid",
    NOT_AFTER_MISSING: "not-after-missing",
    NOT_AFTER_INVALID: "not-after-invalid",
    NOT_BEFORE_MISSING: "not-before-missing",
    NOT_BEFORE_INVALID: "not-before-invalid",
    RANGE_INVALID: "range-invalid",
    NOW_MISSING: "now-missing",
    NOW_INVALID: "now-invalid",
    EXPIRED: "expired",
    EXPIRING: "expiring",
    HOSTNAME_NOT_CHECKED: "hostname-not-checked",
    HOSTNAME_INVALID: "hostname-invalid",
    HOSTNAME_UNKNOWN: "hostname-unknown",
    HOSTNAME_MISMATCH: "hostname-mismatch"
  });
  assert.equal(Object.isFrozen(CERT_VERDICTS), true);
  assert.equal(Object.isFrozen(CERT_NOTES), true);
  assert.equal(DEFAULT_WARN_DAYS, 30);
  assert.equal(MAX_SAN_ENTRIES, 50);
});

// ---------------------------------------------------------------------------
// 安全边界：本模块是纯函数层，不读证书、不联网
// ---------------------------------------------------------------------------

test("certificate-check.mjs stays pure: no imports, no fs/process/network access", async () => {
  const source = await readFile(MODULE_PATH, "utf8");

  assert.equal(/^\s*import\s/m.test(source), false, "module must not import anything");
  assert.equal(/\brequire\s*\(/.test(source), false, "module must not require anything");
  assert.equal(source.includes("node:"), false, "module must not reference any node: specifier");
  for (const specifier of [
    "node:fs",
    "node:child_process",
    "node:http",
    "node:https",
    "node:net",
    "node:tls",
    "node:crypto",
    "node:dns",
    "node:os",
    "node:path"
  ]) {
    assert.equal(source.includes(specifier), false, `module must not reference ${specifier}`);
  }
  assert.equal(/\bfetch\s*\(/.test(source), false, "module must not perform network calls");
  assert.equal(/\bXMLHttpRequest\s*\(/.test(source), false, "module must not perform network calls");
  assert.equal(/\bprocess\s*\./.test(source), false, "module must not read process state");
  assert.equal(/\bexecSync\s*\(/.test(source), false, "module must not spawn commands");
  assert.equal(/\bopenssl\b/.test(source), false, "module must not invoke openssl");
});

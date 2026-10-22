/**
 * Phase 192 — SMART 盘健康解析层（纯函数）测试。
 *
 * 只覆盖纯逻辑：不执行 smartctl、不读设备节点、不访问网络。
 * 运行：node --test tests/phase-192-smart-health.test.mjs
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  CRC_ERROR_ATTRIBUTE_ID,
  MEDIA_ERROR_ATTRIBUTE_IDS,
  REQUIRED_ATTRIBUTE_IDS,
  SMART_FINDING_CODES,
  SMART_INFO_FIELDS,
  SMART_NOTE_CODES,
  SMART_SEVERITIES,
  SMART_SUPPORT,
  SMART_VERDICTS,
  TEMPERATURE_FAILED_CELSIUS,
  TEMPERATURE_WARNING_CELSIUS,
  VERDICT_PRECEDENCE,
  parseSmartAttributes,
  parseSmartInfo,
  summarizeSmartHealth
} from "../apps/fnos-nas-agent/app/smart-health.mjs";

const MODULE_URL = new URL("../apps/fnos-nas-agent/app/smart-health.mjs", import.meta.url);

/** ATA 盘的 `smartctl -i` 样本（两行 SMART support 是真实输出里最常见的形态）。 */
const ATA_INFO_TEXT = `smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.1.0-fnos] (local build)
Copyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org

=== START OF INFORMATION SECTION ===
Model Family:     Samsung based SSDs
Device Model:     Samsung SSD 860 EVO 500GB
Serial Number:    S3Z2NB0K123456
LU WWN Device Id: 5 002538 d4245b0e2
Firmware Version: RVT04B6Q
User Capacity:    500,107,862,016 bytes [500 GB]
Sector Size:      512 bytes logical/physical
Rotation Rate:    Solid State Device
Form Factor:      2.5 inches
Device is:        In smartctl database 7.3/5514
ATA Version is:   ACS-4 T13/BSR INCITS 529 revision 5
SATA Version is:  SATA 3.3, 6.0 Gb/s (current: 6.0 Gb/s)
SMART support is: Available - device has SMART capability.
SMART support is: Enabled
`;

/** NVMe 风格的 `-i` 文本：模型标签叫 Model Number，字段名与 ATA 不同。 */
const NVME_INFO_TEXT = `smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.1.0-fnos] (local build)

=== START OF INFORMATION SECTION ===
Model Number:                       Samsung SSD 970 EVO Plus 500GB
Serial Number:                      S4EWNX0M123456
Firmware Version:                   2B2QEXM7
Total NVM Capacity:                 500,107,862,016 [500 GB]
Unallocated NVM Capacity:           0
Controller ID:                      4
NVMe Version:                       1.3
Power On Hours:                     23,456
`;

const SMART_UNAVAILABLE_TEXT = `=== START OF INFORMATION SECTION ===
Device Model:     Virtual Disk
Serial Number:    SN-VIRTUAL-01
Firmware Version: 1.0
SMART support is: Unavailable - device lacks SMART capability.
`;

const SMART_DISABLED_TEXT = `=== START OF INFORMATION SECTION ===
Device Model:     WDC WD40EFRX-68N32N0
SMART support is: Available - device has SMART capability.
SMART support is: Disabled
`;

const SMART_AMBIGUOUS_TEXT = `=== START OF INFORMATION SECTION ===
SMART support is: Ambiguous - ATA IDENTIFY DEVICE words 82-83 don't show if SMART is enabled.
`;

/** 一份干净、六项判定属性齐全的 ATA 属性表。 */
const ATA_ATTRIBUTES_CLEAN_TEXT = `smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.1.0-fnos] (local build)
Copyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org

=== START OF READ SMART DATA SECTION ===
SMART Attributes Data Structure revision number: 16
Vendor Specific SMART Attributes with Thresholds:
ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE
  5 Reallocated_Sector_Ct   0x0033   100   100   010    Pre-fail  Always       -       0
  9 Power_On_Hours          0x0032   098   098   000    Old_age   Always       -       1234
187 Reported_Uncorrect      0x0032   100   100   000    Old_age   Always       -       0
194 Temperature_Celsius     0x0022   056   045   000    Old_age   Always       -       44 (0 18 0 0 0)
197 Current_Pending_Sector  0x0012   100   100   000    Old_age   Always       -       0
198 Offline_Uncorrectable   0x0010   100   100   000    Old_age   Offline      -       0
199 UDMA_CRC_Error_Count    0x003e   200   200   000    Old_age   Always       -       0

SMART Error Log Version: 1
No Errors Logged
`;

/** 带 FAILING_NOW 与三类坏行（bad value、缺列、越界 id）的属性表。 */
const ATA_ATTRIBUTES_FAILING_TEXT = `=== START OF READ SMART DATA SECTION ===
Vendor Specific SMART Attributes with Thresholds:
ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE
  5 Reallocated_Sector_Ct   0x0033   100   100   010    Pre-fail  Always   FAILING_NOW 8
  5 Reallocated_Sector_Ct   0x0033   100   100   --    Pre-fail  Always       -       0
197 Current_Pending_Sector
999 Out_Of_Range_Id         0x0032   100   100   000    Old_age   Always       -       0
  not a data row at all
`;

/** 干净的 `-i` 信息对象（作为 summarizeSmartHealth 的输入夹具）。 */
const CLEAN_INFO = Object.freeze({
  modelFamily: "Samsung based SSDs",
  model: "Samsung SSD 860 EVO 500GB",
  serialNumber: "S3Z2NB0K123456",
  firmwareVersion: "RVT04B6Q",
  rotationRate: "Solid State Device",
  powerOnHours: null,
  smartSupport: SMART_SUPPORT.AVAILABLE,
  parsed: true
});

function attributeRecord(id, name, raw, overrides = {}) {
  return {
    id,
    name,
    value: 100,
    worst: 100,
    threshold: 0,
    raw,
    whenFailed: null,
    ...overrides
  };
}

/** 六项判定属性都在且 RAW 都可读的最小健康集合。 */
function cleanAttributes() {
  return [
    attributeRecord(5, "Reallocated_Sector_Ct", "0"),
    attributeRecord(187, "Reported_Uncorrect", "0"),
    attributeRecord(194, "Temperature_Celsius", "38"),
    attributeRecord(197, "Current_Pending_Sector", "0"),
    attributeRecord(198, "Offline_Uncorrectable", "0"),
    attributeRecord(199, "UDMA_CRC_Error_Count", "0")
  ];
}

function temperatureSummary(raw) {
  const attributes = cleanAttributes().map(record => (
    record.id === 194 ? { ...record, raw } : record
  ));
  return summarizeSmartHealth({ info: CLEAN_INFO, attributes });
}

test("parseSmartInfo maps the whitelisted ATA fields and keeps the field order", () => {
  const info = parseSmartInfo(ATA_INFO_TEXT);

  assert.deepEqual(info, {
    modelFamily: "Samsung based SSDs",
    model: "Samsung SSD 860 EVO 500GB",
    serialNumber: "S3Z2NB0K123456",
    firmwareVersion: "RVT04B6Q",
    rotationRate: "Solid State Device",
    powerOnHours: null,
    smartSupport: SMART_SUPPORT.AVAILABLE,
    parsed: true
  });
  assert.deepEqual(Object.keys(info), [...SMART_INFO_FIELDS, "parsed"]);
});

test("parseSmartInfo accepts NVMe style labels and a comma formatted Power On Hours", () => {
  const info = parseSmartInfo(NVME_INFO_TEXT);

  assert.equal(info.modelFamily, null);
  assert.equal(info.model, "Samsung SSD 970 EVO Plus 500GB");
  assert.equal(info.serialNumber, "S4EWNX0M123456");
  assert.equal(info.firmwareVersion, "2B2QEXM7");
  assert.equal(info.rotationRate, null);
  assert.equal(info.powerOnHours, 23456);
  assert.equal(info.smartSupport, null);
  assert.equal(info.parsed, true);
});

test("parseSmartInfo returns all null with parsed false for empty or non text input", () => {
  const inputs = [
    undefined,
    null,
    42,
    {},
    [],
    "",
    "   \n\t",
    "smartctl 7.4 2023-08-01 r5530 (local build)",
    "no colon here at all"
  ];

  for (const input of inputs) {
    const info = parseSmartInfo(input);
    assert.equal(info.parsed, false, `parsed for ${String(input)}`);
    for (const field of SMART_INFO_FIELDS) {
      assert.equal(info[field], null, `${field} for ${String(input)}`);
    }
  }
});

test("parseSmartInfo maps unavailable, disabled and ambiguous SMART support without guessing", () => {
  assert.equal(parseSmartInfo(SMART_UNAVAILABLE_TEXT).smartSupport, SMART_SUPPORT.UNAVAILABLE);
  // Disabled：设备有 SMART 但被关掉，属性读不到，对「能不能拿属性」等价于不可用。
  assert.equal(parseSmartInfo(SMART_DISABLED_TEXT).smartSupport, SMART_SUPPORT.UNAVAILABLE);

  const ambiguous = parseSmartInfo(SMART_AMBIGUOUS_TEXT);
  assert.equal(ambiguous.smartSupport, null);
  assert.equal(ambiguous.parsed, true);
});

test("parseSmartInfo never fills a missing whitelist field from another field", () => {
  const info = parseSmartInfo([
    "=== START OF INFORMATION SECTION ===",
    "Model Family:     Western Digital Red",
    "User Capacity:    4,000,787,030,016 bytes [4.00 TB]",
    "LU WWN Device Id: 5 000c50 0a1b2c3d4",
    "Form Factor:      3.5 inches",
    "SMART support is: Available - device has SMART capability.",
    "SMART support is: Enabled"
  ].join("\n"));

  // 只有 Model Family 出现：model / serialNumber / firmwareVersion / rotationRate / powerOnHours 都是 null。
  assert.deepEqual(info, {
    modelFamily: "Western Digital Red",
    model: null,
    serialNumber: null,
    firmwareVersion: null,
    rotationRate: null,
    powerOnHours: null,
    smartSupport: SMART_SUPPORT.AVAILABLE,
    parsed: true
  });
});

test("parseSmartInfo keeps text values verbatim and only accepts integral Power On Hours", () => {
  const info = parseSmartInfo([
    "Model Family:     Western Digital Red",
    "Device Model:     WDC WD40EFRX-68N32N0",
    "Rotation Rate:    5400 rpm",
    "Power On Hours:   23,456",
    "SMART support is: Available - device has SMART capability.",
    "SMART support is: Enabled"
  ].join("\n"));

  assert.equal(info.rotationRate, "5400 rpm");
  assert.equal(info.powerOnHours, 23456);

  for (const raw of ["twelve", "12 h", "", "1.234"]) {
    const unusable = parseSmartInfo(`Power On Hours: ${raw}`);
    assert.equal(unusable.powerOnHours, null, `powerOnHours for ${JSON.stringify(raw)}`);
  }
});

test("parseSmartAttributes parses the ATA attribute table into typed records", () => {
  const rows = parseSmartAttributes(ATA_ATTRIBUTES_CLEAN_TEXT);

  assert.deepEqual(rows, [
    { id: 5, name: "Reallocated_Sector_Ct", value: 100, worst: 100, threshold: 10, raw: "0", whenFailed: null },
    { id: 9, name: "Power_On_Hours", value: 98, worst: 98, threshold: 0, raw: "1234", whenFailed: null },
    { id: 187, name: "Reported_Uncorrect", value: 100, worst: 100, threshold: 0, raw: "0", whenFailed: null },
    { id: 194, name: "Temperature_Celsius", value: 56, worst: 45, threshold: 0, raw: "44 (0 18 0 0 0)", whenFailed: null },
    { id: 197, name: "Current_Pending_Sector", value: 100, worst: 100, threshold: 0, raw: "0", whenFailed: null },
    { id: 198, name: "Offline_Uncorrectable", value: 100, worst: 100, threshold: 0, raw: "0", whenFailed: null },
    { id: 199, name: "UDMA_CRC_Error_Count", value: 200, worst: 200, threshold: 0, raw: "0", whenFailed: null }
  ]);
  assert.equal(rows.length, 7);
  assert.equal(rows.skipped, 0);
});

test("parseSmartAttributes keeps RAW_VALUE verbatim instead of truncating it to a number", () => {
  const rows = parseSmartAttributes(ATA_ATTRIBUTES_CLEAN_TEXT);
  const temperature = rows.find(row => row.id === 194);
  const powerOnHours = rows.find(row => row.id === 9);

  assert.equal(typeof temperature.raw, "string");
  assert.equal(temperature.raw, "44 (0 18 0 0 0)");
  assert.equal(powerOnHours.raw, "1234");
  assert.equal(powerOnHours.value, 98);
});

test("parseSmartAttributes maps WHEN_FAILED and keeps '-' as null", () => {
  const rows = parseSmartAttributes(ATA_ATTRIBUTES_FAILING_TEXT);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: 5,
    name: "Reallocated_Sector_Ct",
    value: 100,
    worst: 100,
    threshold: 10,
    raw: "8",
    whenFailed: "FAILING_NOW"
  });
  assert.equal(rows.skipped, 3);
});

test("parseSmartAttributes skips malformed data rows without counting headers or banners", () => {
  const rows = parseSmartAttributes(ATA_ATTRIBUTES_FAILING_TEXT);

  // 3 条坏数据行被计数：value 为 "--"、缺列、id 越界；表头/banner/分节线/普通文本不计。
  assert.equal(rows.skipped, 3);
  assert.equal(rows.length, 1);

  const headerOnly = parseSmartAttributes([
    "smartctl 7.4 2023-08-01 r5530 (local build)",
    "=== START OF READ SMART DATA SECTION ===",
    "ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE",
    "No Errors Logged"
  ].join("\n"));
  assert.deepEqual(headerOnly, []);
  assert.equal(headerOnly.skipped, 0);
});

test("parseSmartAttributes exposes the skip counter as a non enumerable property", () => {
  const rows = parseSmartAttributes(ATA_ATTRIBUTES_FAILING_TEXT);

  assert.equal(rows.skipped, 3);
  assert.equal(Object.prototype.propertyIsEnumerable.call(rows, "skipped"), false);
  assert.equal(Object.keys(rows).length, rows.length);
  assert.equal(JSON.stringify(rows).includes("skipped"), false);
  // 非枚举 = 对 deepEqual 透明：数组仍然等于普通数组。
  assert.deepEqual(rows, [...rows]);
  assert.deepEqual(parseSmartAttributes(ATA_ATTRIBUTES_CLEAN_TEXT), [...parseSmartAttributes(ATA_ATTRIBUTES_CLEAN_TEXT)]);
});

test("parseSmartAttributes returns an empty array with skip counter 0 for empty or non text input", () => {
  for (const input of [undefined, null, 42, {}, "", "   \n", "no attribute table here"]) {
    const rows = parseSmartAttributes(input);
    assert.deepEqual(rows, [], `rows for ${String(input)}`);
    assert.equal(rows.skipped, 0, `skipped for ${String(input)}`);
  }
});

test("summarizeSmartHealth returns ok only for an available, fully covered and clean report", () => {
  const info = parseSmartInfo(ATA_INFO_TEXT);
  const attributes = parseSmartAttributes(ATA_ATTRIBUTES_CLEAN_TEXT);

  assert.deepEqual(
    summarizeSmartHealth({ info, attributes }),
    { verdict: SMART_VERDICTS.OK, findings: [], notes: [] }
  );
});

test("summarizeSmartHealth reports a warning for every media error counter above zero", () => {
  const expectedCodes = new Map([
    [5, SMART_FINDING_CODES.REALLOCATED_SECTORS],
    [187, SMART_FINDING_CODES.REPORTED_UNCORRECTABLE],
    [197, SMART_FINDING_CODES.CURRENT_PENDING_SECTORS],
    [198, SMART_FINDING_CODES.OFFLINE_UNCORRECTABLE]
  ]);

  for (const id of MEDIA_ERROR_ATTRIBUTE_IDS) {
    const attributes = cleanAttributes().map(record => (
      record.id === id ? { ...record, raw: "4" } : record
    ));
    const summary = summarizeSmartHealth({ info: CLEAN_INFO, attributes });

    assert.equal(summary.verdict, SMART_VERDICTS.WARNING, `verdict for attribute ${id}`);
    assert.deepEqual(summary.notes, []);
    assert.deepEqual(summary.findings.map(finding => ({
      attributeId: finding.attributeId,
      code: finding.code,
      severity: finding.severity
    })), [{ attributeId: id, code: expectedCodes.get(id), severity: SMART_SEVERITIES.WARNING }]);
    assert.match(summary.findings[0].detail, /raw=4/);
  }
});

test("summarizeSmartHealth attributes UDMA CRC errors to the cable or the interface", () => {
  const attributes = cleanAttributes().map(record => (
    record.id === CRC_ERROR_ATTRIBUTE_ID ? { ...record, raw: "12" } : record
  ));
  const summary = summarizeSmartHealth({ info: CLEAN_INFO, attributes });

  assert.equal(summary.verdict, SMART_VERDICTS.WARNING);
  assert.equal(summary.findings.length, 1);
  assert.equal(summary.findings[0].attributeId, CRC_ERROR_ATTRIBUTE_ID);
  assert.equal(summary.findings[0].code, SMART_FINDING_CODES.UDMA_CRC_ERRORS);
  assert.match(summary.findings[0].detail, /线材/);
  assert.match(summary.findings[0].detail, /接口/);
  assert.match(summary.findings[0].detail, /SATA/);
});

test("summarizeSmartHealth warns above 55C and fails above 65C", () => {
  assert.equal(TEMPERATURE_WARNING_CELSIUS, 55);
  assert.equal(TEMPERATURE_FAILED_CELSIUS, 65);

  const at55 = temperatureSummary("55");
  assert.equal(at55.verdict, SMART_VERDICTS.OK);
  assert.deepEqual(at55.findings, []);

  const at56 = temperatureSummary("56");
  assert.equal(at56.verdict, SMART_VERDICTS.WARNING);
  assert.deepEqual(at56.findings.map(finding => [finding.attributeId, finding.code, finding.severity]), [
    [194, SMART_FINDING_CODES.TEMPERATURE_HIGH, SMART_SEVERITIES.WARNING]
  ]);

  const at65 = temperatureSummary("65 (45 65 0 0 0)");
  assert.equal(at65.verdict, SMART_VERDICTS.WARNING);
  assert.equal(at65.findings.length, 1);
  assert.equal(at65.findings[0].code, SMART_FINDING_CODES.TEMPERATURE_HIGH);

  const at66 = temperatureSummary("66");
  assert.equal(at66.verdict, SMART_VERDICTS.FAILED);
  assert.equal(at66.findings.length, 1);
  assert.deepEqual(at66.findings.map(finding => [finding.attributeId, finding.code, finding.severity]), [
    [194, SMART_FINDING_CODES.TEMPERATURE_CRITICAL, SMART_SEVERITIES.FAILED]
  ]);
});

test("summarizeSmartHealth fails on any non empty when_failed, even outside the judged attributes", () => {
  const attributes = [
    ...cleanAttributes(),
    attributeRecord(184, "End-to-End_Error", "0", { whenFailed: "FAILING_NOW" })
  ];
  const summary = summarizeSmartHealth({ info: CLEAN_INFO, attributes });

  assert.equal(summary.verdict, SMART_VERDICTS.FAILED);
  assert.deepEqual(summary.findings.map(finding => [finding.attributeId, finding.code, finding.severity]), [
    [184, SMART_FINDING_CODES.ATTRIBUTE_FAILED, SMART_SEVERITIES.FAILED]
  ]);
  assert.match(summary.findings[0].detail, /FAILING_NOW/);
});

test("summarizeSmartHealth sorts findings by attribute id and keeps the order stable", () => {
  const attributes = [
    attributeRecord(199, "UDMA_CRC_Error_Count", "3"),
    attributeRecord(194, "Temperature_Celsius", "60"),
    attributeRecord(198, "Offline_Uncorrectable", "1"),
    attributeRecord(197, "Current_Pending_Sector", "2"),
    attributeRecord(187, "Reported_Uncorrect", "5"),
    attributeRecord(5, "Reallocated_Sector_Ct", "8")
  ];
  const summary = summarizeSmartHealth({ info: CLEAN_INFO, attributes });

  assert.equal(summary.verdict, SMART_VERDICTS.WARNING);
  assert.deepEqual(summary.findings.map(finding => finding.attributeId), [5, 187, 194, 197, 198, 199]);
  assert.deepEqual(summary.findings.map(finding => finding.code), [
    SMART_FINDING_CODES.REALLOCATED_SECTORS,
    SMART_FINDING_CODES.REPORTED_UNCORRECTABLE,
    SMART_FINDING_CODES.TEMPERATURE_HIGH,
    SMART_FINDING_CODES.CURRENT_PENDING_SECTORS,
    SMART_FINDING_CODES.OFFLINE_UNCORRECTABLE,
    SMART_FINDING_CODES.UDMA_CRC_ERRORS
  ]);

  // 同一属性同时触发 when_failed 与 raw>0：failed 排在 warning 前，整体仍按 id 升序。
  const mixed = summarizeSmartHealth({
    info: CLEAN_INFO,
    attributes: cleanAttributes().map(record => (
      record.id === 5 ? { ...record, raw: "2", whenFailed: "FAILING_NOW" } : record
    ))
  });
  assert.equal(mixed.verdict, SMART_VERDICTS.FAILED);
  assert.deepEqual(mixed.findings.map(finding => [finding.attributeId, finding.code]), [
    [5, SMART_FINDING_CODES.ATTRIBUTE_FAILED],
    [5, SMART_FINDING_CODES.REALLOCATED_SECTORS]
  ]);

  // 同样输入重复调用，顺序与内容完全一致。
  assert.deepEqual(
    summarizeSmartHealth({ info: CLEAN_INFO, attributes }).findings,
    summary.findings
  );
});

test("summarizeSmartHealth never writes ok when SMART is unavailable, attributes are empty or input is unparsable", () => {
  const cases = [
    [
      summarizeSmartHealth({ info: { ...CLEAN_INFO, smartSupport: SMART_SUPPORT.UNAVAILABLE }, attributes: cleanAttributes() }),
      SMART_NOTE_CODES.SMART_SUPPORT_UNAVAILABLE
    ],
    [
      summarizeSmartHealth({ info: { ...CLEAN_INFO, smartSupport: null }, attributes: cleanAttributes() }),
      SMART_NOTE_CODES.SMART_SUPPORT_UNKNOWN
    ],
    [
      summarizeSmartHealth({ info: { ...CLEAN_INFO, smartSupport: "Ambiguous" }, attributes: cleanAttributes() }),
      SMART_NOTE_CODES.SMART_SUPPORT_UNKNOWN
    ],
    [
      summarizeSmartHealth({ info: { ...CLEAN_INFO, parsed: false }, attributes: cleanAttributes() }),
      "invalid-input:info-unparsable"
    ],
    [
      summarizeSmartHealth({ info: null, attributes: cleanAttributes() }),
      "invalid-input:info"
    ],
    [
      summarizeSmartHealth({ info: CLEAN_INFO, attributes: [] }),
      SMART_NOTE_CODES.NO_ATTRIBUTES
    ],
    [
      summarizeSmartHealth({ info: CLEAN_INFO, attributes: null }),
      "invalid-input:attributes"
    ]
  ];

  for (const [summary, expectedNote] of cases) {
    assert.equal(summary.verdict, SMART_VERDICTS.UNKNOWN);
    assert.deepEqual(summary.findings, []);
    assert.ok(summary.notes.includes(expectedNote), `missing note ${expectedNote} in ${summary.notes.join(",")}`);
  }

  const noArguments = summarizeSmartHealth(null);
  assert.equal(noArguments.verdict, SMART_VERDICTS.UNKNOWN);
  assert.deepEqual(noArguments.notes, ["invalid-input:arguments"]);
});

test("summarizeSmartHealth records missing attributes in notes and refuses to call them passing", () => {
  const missing = summarizeSmartHealth({
    info: CLEAN_INFO,
    attributes: cleanAttributes().filter(record => record.id !== 197 && record.id !== 198)
  });

  assert.equal(missing.verdict, SMART_VERDICTS.UNKNOWN);
  assert.deepEqual(missing.findings, []);
  assert.deepEqual(missing.notes, ["missing-attribute:197", "missing-attribute:198"]);
  assert.equal(new Set(missing.notes).size, missing.notes.length);

  const onlyCrcMissing = summarizeSmartHealth({
    info: CLEAN_INFO,
    attributes: cleanAttributes().filter(record => record.id !== CRC_ERROR_ATTRIBUTE_ID)
  });
  assert.equal(onlyCrcMissing.verdict, SMART_VERDICTS.UNKNOWN);
  assert.deepEqual(onlyCrcMissing.notes, [`missing-attribute:${CRC_ERROR_ATTRIBUTE_ID}`]);
});

test("summarizeSmartHealth keeps skipped lines, invalid entries and unreadable RAW values out of ok", () => {
  const info = parseSmartInfo(ATA_INFO_TEXT);
  const rows = parseSmartAttributes(`${ATA_ATTRIBUTES_CLEAN_TEXT}  9 Power_On_Hours 0x0032 098 098\n`);

  assert.equal(rows.length, 7);
  assert.equal(rows.skipped, 1);

  const skipped = summarizeSmartHealth({ info, attributes: rows });
  assert.equal(skipped.verdict, SMART_VERDICTS.UNKNOWN);
  assert.deepEqual(skipped.findings, []);
  assert.deepEqual(skipped.notes, ["skipped-attribute-lines:1"]);

  // 被跳过的行不阻止真实告警上报：warning 优先于 unknown。
  for (const row of rows) {
    if (row.id === 5) row.raw = "3";
  }
  const warned = summarizeSmartHealth({ info, attributes: rows });
  assert.equal(warned.verdict, SMART_VERDICTS.WARNING);
  assert.deepEqual(warned.notes, ["skipped-attribute-lines:1"]);
  assert.deepEqual(warned.findings.map(finding => finding.code), [SMART_FINDING_CODES.REALLOCATED_SECTORS]);

  const invalidEntries = summarizeSmartHealth({
    info,
    attributes: [...parseSmartAttributes(ATA_ATTRIBUTES_CLEAN_TEXT), "not-a-record", { id: 999, name: "Nope", raw: "0" }]
  });
  assert.equal(invalidEntries.verdict, SMART_VERDICTS.UNKNOWN);
  assert.deepEqual(invalidEntries.notes, ["invalid-attribute-entry:2"]);

  const unreadable = parseSmartAttributes(ATA_ATTRIBUTES_CLEAN_TEXT);
  for (const row of unreadable) {
    if (row.id === 194) row.raw = "---";
  }
  const unreadableSummary = summarizeSmartHealth({ info, attributes: unreadable });
  assert.equal(unreadableSummary.verdict, SMART_VERDICTS.UNKNOWN);
  assert.deepEqual(unreadableSummary.findings, []);
  assert.deepEqual(unreadableSummary.notes, ["unreadable-attribute:194"]);
});

test("summarizeSmartHealth never throws on garbage input and keeps the result contract", () => {
  const inputs = [
    undefined,
    null,
    42,
    "text",
    [],
    {},
    { info: null, attributes: null },
    { info: {}, attributes: {} },
    { info: { smartSupport: "available" }, attributes: [{ id: 5 }, { id: 300 }, null, [], 7] },
    { info: { parsed: true, smartSupport: "available" }, attributes: [{ id: 194, name: 42, raw: {}, whenFailed: 9 }] }
  ];

  for (const input of inputs) {
    const summary = summarizeSmartHealth(input);
    assert.ok(Object.values(SMART_VERDICTS).includes(summary.verdict), `verdict for ${JSON.stringify(input)}`);
    assert.ok(Array.isArray(summary.findings));
    assert.ok(Array.isArray(summary.notes));
    assert.equal(new Set(summary.notes).size, summary.notes.length);
    assert.ok(summary.findings.every(finding => (
      typeof finding.code === "string"
      && Object.values(SMART_SEVERITIES).includes(finding.severity)
      && Number.isInteger(finding.attributeId)
      && typeof finding.detail === "string"
    )));
  }
});

test("smart-health.mjs stays a dependency free pure module with frozen rule constants", async () => {
  const source = await readFile(MODULE_URL, "utf8");

  assert.equal(/^\s*import\s/m.test(source), false, "module must not import anything");
  assert.equal(/\brequire\s*\(/.test(source), false, "module must not require anything");
  assert.equal(/from\s+["']/.test(source), false, "module must not re-export from a specifier");
  for (const specifier of ["node:fs", "node:child_process", "node:http", "node:https", "node:net", "child_process", "fs/promises"]) {
    assert.equal(source.includes(specifier), false, `module must not reference ${specifier}`);
  }
  assert.equal(/\b(?:execSync|spawnSync|fetch)\s*\(/.test(source), false, "module must not perform I/O");

  assert.ok(Object.isFrozen(SMART_SUPPORT));
  assert.ok(Object.isFrozen(SMART_VERDICTS));
  assert.ok(Object.isFrozen(SMART_FINDING_CODES));
  assert.ok(Object.isFrozen(SMART_NOTE_CODES));
  assert.ok(Object.isFrozen(VERDICT_PRECEDENCE));
  assert.deepEqual([...VERDICT_PRECEDENCE], ["failed", "warning", "unknown", "ok"]);
  assert.deepEqual([...MEDIA_ERROR_ATTRIBUTE_IDS], [5, 187, 197, 198]);
  assert.deepEqual([...REQUIRED_ATTRIBUTE_IDS], [5, 187, 194, 197, 198, 199]);
  assert.equal(CRC_ERROR_ATTRIBUTE_ID, 199);
  assert.equal(TEMPERATURE_WARNING_CELSIUS, 55);
  assert.equal(TEMPERATURE_FAILED_CELSIUS, 65);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createCapacityHistory, normalizeRecord, HISTORY_FILE_NAME } from "../apps/fnos-nas-agent/app/capacity-history.mjs";
import { createSystemctlCollector, FNOS_SERVICE_UNITS, SYSTEMCTL_PROPERTIES } from "../apps/fnos-nas-agent/app/service-status-collector.mjs";
import { parseSystemctlShow, describeServiceVerdict, validateUnitName } from "../apps/fnos-nas-agent/app/service-status.mjs";

/** 内存版 fs：只实现 capacity-history 用到的那几个方法。 */
function createMemoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  return {
    files,
    existsSync: (path) => dirs.has(path) || files.has(path),
    mkdirSync: (path) => { dirs.add(path); },
    readFileSync: (path) => {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return files.get(path);
    },
    writeFileSync: (path, content) => { files.set(path, content); },
    renameSync: (from, to) => {
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    unlinkSync: (path) => { files.delete(path); }
  };
}

test("normalizeRecord keeps only well-formed disks and rejects unusable records", () => {
  const record = normalizeRecord({
    at: "2026-10-24T00:00:00.000Z",
    disks: [
      { name: "vol1", totalBytes: 100, usedBytes: 40 },
      { name: "  ", totalBytes: 1, usedBytes: 1 },
      { name: "vol2", totalBytes: null, usedBytes: null },
      "nope"
    ]
  });
  assert.deepEqual(record, { at: "2026-10-24T00:00:00.000Z", disks: [{ name: "vol1", totalBytes: 100, usedBytes: 40 }] });
  assert.equal(normalizeRecord({ at: "not-a-date", disks: [{ name: "v", usedBytes: 1 }] }), null);
  assert.equal(normalizeRecord({ at: "2026-10-24T00:00:00.000Z", disks: [] }), null);
});

test("append writes one record per interval and reports why a sample was skipped", () => {
  const fs = createMemoryFs();
  const history = createCapacityHistory({ dataDir: "/data", minIntervalMs: 3600_000, fs });
  const first = history.append({ at: "2026-10-24T00:00:00.000Z", disks: [{ name: "vol1", totalBytes: 100, usedBytes: 10 }] });
  assert.equal(first.appended, true);
  assert.equal(first.records.length, 1);

  const tooSoon = history.append({ at: "2026-10-24T00:20:00.000Z", disks: [{ name: "vol1", totalBytes: 100, usedBytes: 20 }] });
  assert.equal(tooSoon.appended, false);
  assert.equal(tooSoon.reason, "recent-sample");

  const outOfOrder = history.append({ at: "2026-10-23T00:00:00.000Z", disks: [{ name: "vol1", totalBytes: 100, usedBytes: 5 }] });
  assert.equal(outOfOrder.appended, false);
  assert.equal(outOfOrder.reason, "out-of-order");

  const later = history.append({ at: "2026-10-24T02:00:00.000Z", disks: [{ name: "vol1", totalBytes: 100, usedBytes: 30 }] });
  assert.equal(later.appended, true);
  assert.equal(later.records.length, 2);
  assert.equal(history.filePath(), join("/data", HISTORY_FILE_NAME));
});

test("a corrupted history file is treated as empty instead of failing the route", () => {
  const fs = createMemoryFs({ [join("/data", HISTORY_FILE_NAME)]: "{not json" });
  const history = createCapacityHistory({ dataDir: "/data", fs });
  assert.deepEqual(history.read(), { records: [] });
  const appended = history.append({ at: "2026-10-24T00:00:00.000Z", disks: [{ name: "vol1", totalBytes: 10, usedBytes: 1 }] });
  assert.equal(appended.appended, true);
  assert.equal(appended.records.length, 1);
});

test("history caps the number of records and refuses to work without a data directory", () => {
  const fs = createMemoryFs();
  const history = createCapacityHistory({ dataDir: "/data", maxRecords: 3, minIntervalMs: 0, fs });
  for (let hour = 0; hour < 5; hour += 1) {
    history.append({ at: `2026-10-24T0${hour}:00:00.000Z`, disks: [{ name: "vol1", totalBytes: 10, usedBytes: hour }] });
  }
  const { records } = history.read();
  assert.equal(records.length, 3);
  assert.equal(records[2].disks[0].usedBytes, 4);

  const detached = createCapacityHistory({ dataDir: "", fs });
  assert.deepEqual(detached.read(), { records: [] });
  assert.equal(detached.append({ at: "2026-10-24T00:00:00.000Z", disks: [{ name: "v", usedBytes: 1 }] }).reason, "no-data-dir");
});

test("the unit whitelist only contains names the validator accepts", () => {
  assert.ok(FNOS_SERVICE_UNITS.length >= 8);
  for (const unit of FNOS_SERVICE_UNITS) {
    const validation = validateUnitName(unit);
    assert.equal(validation.ok, true, `${unit} must pass validateUnitName`);
  }
});

test("the collector calls systemctl with fixed argv and no shell", async () => {
  const calls = [];
  const collector = createSystemctlCollector({
    execFile: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: "ActiveState=active\nSubState=running\n" };
    }
  });
  const output = await collector("filestor_service.service");
  assert.match(output, /ActiveState=active/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "systemctl");
  assert.deepEqual(calls[0].args, ["show", "filestor_service.service"].concat(SYSTEMCTL_PROPERTIES.flatMap((property) => ["-p", property])));
  assert.equal(calls[0].options.timeout > 0, true);
  assert.equal("shell" in calls[0].options, false);
});

test("the collector refuses names that would not be a plain unit name", async () => {
  let invoked = false;
  const collector = createSystemctlCollector({ execFile: async () => { invoked = true; return { stdout: "" }; } });
  await assert.rejects(() => collector("filestor_service.service; rm -rf /"), /invalid-unit/);
  await assert.rejects(() => collector("../../etc/passwd"), /invalid-unit/);
  assert.equal(invoked, false);
});

test("collector output flows through the parser and yields a verdict", async () => {
  const collector = createSystemctlCollector({
    execFile: async () => ({ stdout: "LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\nMainPID=0\n" })
  });
  const parsed = parseSystemctlShow(await collector("smbd.service"));
  assert.equal(parsed.parsed, true);
  assert.equal(describeServiceVerdict(parsed), "failed");
});

test("the UI ships a services/trend card and a plan-then-apply rename card", async () => {
  const html = await readFile(join(process.cwd(), "apps/fnos-nas-agent/app/ui/index.html"), "utf8");
  const pages = await readFile(join(process.cwd(), "apps/fnos-nas-agent/app/ui/pages.js"), "utf8");
  assert.match(html, /id="runtime-refresh"/);
  assert.match(html, /id="runtime-services"/);
  assert.match(html, /id="runtime-capacity"/);
  assert.match(pages, /\/api\/system\/services/);
  assert.match(pages, /\/api\/system\/capacity-forecast/);
  assert.match(html, /id="rename-preview"/);
  assert.match(html, /id="rename-apply"/);
  assert.match(pages, /\/api\/files\/rename-plan/);
  assert.match(pages, /\/api\/files\/rename-apply/);
  assert.match(pages, /confirm:true/);
  assert.doesNotMatch(pages, /renameResult\.innerHTML/);
  assert.doesNotMatch(pages, /runtimeServices\.innerHTML/);
});

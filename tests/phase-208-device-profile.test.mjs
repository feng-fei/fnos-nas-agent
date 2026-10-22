import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROFILE_FIELDS,
  PREFERENCE_KEYS,
  MAX_PROFILES,
  DEFAULT_STALE_AFTER_MS,
  SCHEMA_VERSION,
  DEVICE_PROFILE_FILE_NAME,
  normalizeProfile,
  mergeProfile,
  profileFreshness,
  redactProfile,
  createDeviceProfileStore
} from "../apps/fnos-nas-agent/app/device-profile.mjs";

const DATA_DIR = "C:\\phase208\\data";
const FILE_PATH = join(DATA_DIR, DEVICE_PROFILE_FILE_NAME);
const DAY_MS = 24 * 60 * 60 * 1000;
const STAMP = "2026-04-01T09:00:00.000Z";

/**
 * In-memory stand-in for the handful of fs/promises calls the store makes.
 * It records open/chmod/rename calls so the atomic-write contract can be
 * asserted on the exact bytes, not just on the parsed result.
 */
function createMemoryFs(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles));
  const opens = [];
  const chmods = [];
  const renames = [];
  return {
    files,
    opens,
    chmods,
    renames,
    mkdir: async () => {},
    async readFile(path) {
      if (!files.has(path)) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
      return files.get(path);
    },
    async open(path, flags, mode) {
      if (flags === "wx" && files.has(path)) throw Object.assign(new Error(`EEXIST ${path}`), { code: "EEXIST" });
      opens.push({ path, flags, mode });
      return {
        async writeFile(data) {
          files.set(path, Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
        },
        async sync() {},
        async close() {}
      };
    },
    async rename(from, to) {
      if (!files.has(from)) throw Object.assign(new Error(`ENOENT ${from}`), { code: "ENOENT" });
      renames.push([from, to]);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async chmod(path, mode) {
      if (!files.has(path)) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
      chmods.push({ path, mode });
    },
    async unlink(path) {
      files.delete(path);
    }
  };
}

function baseProfileInput(overrides = {}) {
  return {
    id: "nas-01",
    hostname: "nas-01",
    model: "F4-2200",
    firmware: "26.1",
    kernel: "6.1.0",
    cpuModel: "N100",
    cpuCores: 4,
    memoryBytes: 8589934592,
    disks: [{ name: "sda", sizeBytes: 1099511627776, serial: "WD-SN123456" }],
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
    preferences: { quietHours: "22:00-07:00", preferredModel: "qwen2.5-7b", notifyLevel: "high" },
    ...overrides
  };
}

test("normalizeProfile keeps whitelisted fields and applies the clock", () => {
  const result = normalizeProfile(baseProfileInput(), { now: STAMP });
  assert.equal(result.ok, true);
  assert.deepEqual(result.droppedFields, []);
  assert.equal(result.profile.id, "nas-01");
  assert.equal(result.profile.hostname, "nas-01");
  assert.equal(result.profile.model, "F4-2200");
  assert.equal(result.profile.cpuCores, 4);
  assert.equal(result.profile.memoryBytes, 8589934592);
  assert.equal(result.profile.timezone, "Asia/Shanghai");
  assert.deepEqual(result.profile.preferences, {
    quietHours: "22:00-07:00",
    preferredModel: "qwen2.5-7b",
    notifyLevel: "high"
  });
  assert.equal(result.profile.createdAt, STAMP);
  assert.equal(result.profile.updatedAt, STAMP);
  // 归一只产出白名单字段，外加 id / disks / preferences / 时间戳。
  const allowed = new Set(["id", "createdAt", "updatedAt", "disks", "preferences", ...PROFILE_FIELDS]);
  for (const key of Object.keys(result.profile)) assert.equal(allowed.has(key), true, `unexpected field ${key}`);
});

test("normalizeProfile drops unknown fields without failing and counts them", () => {
  const result = normalizeProfile(baseProfileInput({ sshPort: 22, password: "hunter2", notes: "hello" }), { now: STAMP });
  assert.equal(result.ok, true);
  assert.deepEqual(result.droppedFields, ["sshPort", "password", "notes"]);
  assert.equal("sshPort" in result.profile, false);
  assert.equal("password" in result.profile, false);
  assert.equal("notes" in result.profile, false);
});

test("normalizeProfile rejects a negative or fractional memoryBytes", () => {
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "8589934592"]) {
    const result = normalizeProfile(baseProfileInput({ memoryBytes: value }), { now: STAMP });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "memory-bytes-invalid");
    assert.equal(result.field, "memoryBytes");
  }
  const zero = normalizeProfile(baseProfileInput({ memoryBytes: 0 }), { now: STAMP });
  assert.equal(zero.ok, true);
  assert.equal(zero.profile.memoryBytes, 0);
});

test("normalizeProfile masks disk serials and keeps only the last four characters", () => {
  const result = normalizeProfile(baseProfileInput({
    disks: [
      { name: "sda", sizeBytes: 10, serial: "WD-SN123456" },
      { name: "sdb", sizeBytes: 20, serial: "1234" },
      { name: "sdc", sizeBytes: 30 }
    ]
  }), { now: STAMP });
  assert.equal(result.ok, true);
  assert.equal(result.profile.disks[0].serial, "*******3456");
  assert.equal(result.profile.disks[0].name, "sda");
  assert.equal(result.profile.disks[1].serial, "****");
  assert.equal("serial" in result.profile.disks[2], false);
  // 归一后的值再归一一次不会继续叠加星号。
  const again = normalizeProfile(result.profile, { now: STAMP });
  assert.equal(again.profile.disks[0].serial, "*******3456");
});

test("normalizeProfile rejects an invalid profile id", () => {
  for (const id of ["NAS", "-nas", "nas 01", "a".repeat(65), ".", "nas/01", ""]) {
    const result = normalizeProfile({ id, hostname: "nas-01" }, { now: STAMP });
    assert.equal(result.ok, false, `id ${JSON.stringify(id)} should be rejected`);
    assert.equal(result.reason, "invalid-id");
  }
  const missing = normalizeProfile({ hostname: "nas-01" }, { now: STAMP });
  assert.equal(missing.reason, "invalid-id");
  const viaOption = normalizeProfile({ hostname: "nas-01" }, { now: STAMP, id: "nas-02" });
  assert.equal(viaOption.ok, true);
  assert.equal(viaOption.profile.id, "nas-02");
});

test("normalizeProfile keeps only whitelisted preferences and truncates values", () => {
  const result = normalizeProfile(baseProfileInput({
    preferences: {
      quietHours: "22:00-07:00",
      preferredModel: "q".repeat(250),
      notifyLevel: 3,
      maxTempC: 42,
      apiToken: "should-be-dropped",
      dbPassword: "also-dropped"
    }
  }), { now: STAMP });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.profile.preferences).sort(), ["notifyLevel", "preferredModel", "quietHours"]);
  assert.equal(result.profile.preferences.preferredModel.length, 200);
  assert.equal(result.profile.preferences.notifyLevel, "3");
  assert.deepEqual(result.droppedFields, ["preferences.maxTempC", "preferences.apiToken", "preferences.dbPassword"]);
  for (const key of Object.keys(result.profile.preferences)) assert.equal(PREFERENCE_KEYS.includes(key), true);
});

test("normalizeProfile rejects malformed disks", () => {
  assert.equal(normalizeProfile(baseProfileInput({ disks: "sda" }), { now: STAMP }).reason, "disks-invalid");
  assert.equal(normalizeProfile(baseProfileInput({ disks: [null] }), { now: STAMP }).reason, "disk-entry-invalid");
  assert.equal(
    normalizeProfile(baseProfileInput({ disks: [{ name: "", sizeBytes: 1 }] }), { now: STAMP }).reason,
    "disk-entry-invalid"
  );
  assert.equal(
    normalizeProfile(baseProfileInput({ disks: [{ name: "sda" }] }), { now: STAMP }).reason,
    "disk-size-invalid"
  );
  assert.equal(
    normalizeProfile(baseProfileInput({ disks: [{ name: "sda", sizeBytes: -1 }] }), { now: STAMP }).reason,
    "disk-size-invalid"
  );
  const tooMany = Array.from({ length: 65 }, (_, index) => ({ name: `sd${index}`, sizeBytes: 1 }));
  assert.equal(normalizeProfile(baseProfileInput({ disks: tooMany }), { now: STAMP }).reason, "disks-too-many");
  const empty = normalizeProfile({ id: "nas-01" }, { now: STAMP });
  assert.deepEqual(empty.profile.disks, []);
  assert.deepEqual(empty.profile.preferences, {});
});

test("normalizeProfile rejects a non-object input and a non-string text field", () => {
  assert.equal(normalizeProfile(null).reason, "invalid-input");
  assert.equal(normalizeProfile("nas-01").reason, "invalid-input");
  const wrongType = normalizeProfile({ id: "nas-01", hostname: 42 }, { now: STAMP });
  assert.equal(wrongType.ok, false);
  assert.equal(wrongType.reason, "field-type-invalid");
  assert.equal(wrongType.field, "hostname");
});

test("mergeProfile deep merges objects, replaces arrays and preserves createdAt", () => {
  const existing = normalizeProfile(baseProfileInput(), { now: "2026-01-01T00:00:00.000Z" }).profile;
  const result = mergeProfile(existing, {
    firmware: "26.2",
    preferences: { notifyLevel: "low" },
    disks: [{ name: "sdb", sizeBytes: 200 }]
  }, { now: "2026-04-01T00:00:00.000Z" });
  assert.equal(result.profile.firmware, "26.2");
  assert.equal(result.profile.hostname, "nas-01", "untouched fields survive the merge");
  assert.deepEqual(result.profile.preferences, {
    quietHours: "22:00-07:00",
    preferredModel: "qwen2.5-7b",
    notifyLevel: "low"
  });
  assert.deepEqual(result.profile.disks, [{ name: "sdb", sizeBytes: 200 }], "arrays are replaced wholesale");
  assert.equal(result.profile.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(result.profile.updatedAt, "2026-04-01T00:00:00.000Z");
});

test("mergeProfile reports only the fields that actually changed", () => {
  const existing = normalizeProfile(baseProfileInput(), { now: "2026-01-01T00:00:00.000Z" }).profile;
  const result = mergeProfile(existing, { firmware: "26.2", preferences: { notifyLevel: "low" } }, { now: STAMP });
  assert.deepEqual(result.changedFields, ["firmware", "preferences.notifyLevel"]);
  assert.deepEqual(result.droppedFields, []);

  const untouched = mergeProfile(existing, {}, { now: STAMP });
  assert.deepEqual(untouched.changedFields, []);
  assert.deepEqual(untouched.profile, { ...existing, updatedAt: STAMP });
});

test("mergeProfile treats null as a field deletion", () => {
  const existing = normalizeProfile(baseProfileInput(), { now: "2026-01-01T00:00:00.000Z" }).profile;
  const result = mergeProfile(existing, { locale: null, preferences: { notifyLevel: null } }, { now: STAMP });
  assert.equal("locale" in result.profile, false);
  assert.equal("notifyLevel" in result.profile.preferences, false);
  assert.equal(result.profile.preferences.quietHours, "22:00-07:00");
  assert.deepEqual(result.changedFields, ["locale", "preferences.notifyLevel"]);
  assert.deepEqual(result.droppedFields, []);
});

test("mergeProfile refuses an id mismatch and a non-object patch", () => {
  const existing = normalizeProfile(baseProfileInput(), { now: "2026-01-01T00:00:00.000Z" }).profile;
  const mismatch = mergeProfile(existing, { id: "nas-02", hostname: "nas-02" }, { now: STAMP });
  assert.deepEqual(mismatch, { ok: false, reason: "id-mismatch" });
  assert.equal(mergeProfile(existing, "patch").reason, "invalid-input");
  const created = mergeProfile({}, { id: "nas-03", hostname: "nas-03" }, { now: STAMP });
  assert.equal(created.profile.id, "nas-03");
  assert.equal(created.profile.createdAt, STAMP);
});

test("profileFreshness reports fresh with the age in whole days", () => {
  const result = profileFreshness(
    { updatedAt: "2026-03-30T00:00:00.000Z" },
    { now: "2026-04-01T00:00:00.000Z" }
  );
  assert.deepEqual(result, { state: "fresh", ageDays: 2, staleAfterMs: DEFAULT_STALE_AFTER_MS });
  const future = profileFreshness(
    { updatedAt: "2026-04-02T00:00:00.000Z" },
    { now: "2026-04-01T00:00:00.000Z" }
  );
  assert.equal(future.state, "fresh");
  assert.equal(future.ageDays, 0);
  assert.equal(DEFAULT_STALE_AFTER_MS, 90 * DAY_MS);
});

test("profileFreshness reports stale past the default threshold", () => {
  const now = Date.parse("2026-07-01T00:00:00.000Z");
  const updatedAt = new Date(now - 91 * DAY_MS).toISOString();
  const result = profileFreshness({ updatedAt }, { now: "2026-07-01T00:00:00.000Z" });
  assert.equal(result.state, "stale");
  assert.equal(result.ageDays, 91);
  assert.equal(result.staleAfterMs, DEFAULT_STALE_AFTER_MS);
});

test("profileFreshness reports unknown for a missing or unparsable timestamp", () => {
  for (const profile of [{}, null, { updatedAt: null }, { updatedAt: "" }, { updatedAt: "not-a-date" }]) {
    const result = profileFreshness(profile, { now: STAMP });
    assert.equal(result.state, "unknown");
    assert.equal(result.ageDays, null);
    assert.equal(result.staleAfterMs, DEFAULT_STALE_AFTER_MS);
  }
});

test("profileFreshness honours a custom threshold and treats the boundary as fresh", () => {
  const now = "2026-04-01T00:00:00.000Z";
  const oneSecondAgo = new Date(Date.parse(now) - 1000).toISOString();
  const boundary = profileFreshness({ updatedAt: oneSecondAgo }, { now, staleAfterMs: 1000 });
  assert.equal(boundary.state, "fresh");
  assert.equal(boundary.staleAfterMs, 1000);
  const justOver = new Date(Date.parse(now) - 1001).toISOString();
  assert.equal(profileFreshness({ updatedAt: justOver }, { now, staleAfterMs: 1000 }).state, "stale");
  const invalidThreshold = profileFreshness({ updatedAt: oneSecondAgo }, { now, staleAfterMs: -5 });
  assert.equal(invalidThreshold.staleAfterMs, DEFAULT_STALE_AFTER_MS);
  assert.equal(invalidThreshold.state, "fresh");
});

test("redactProfile removes sensitive preference keys and masks serials without mutating the input", () => {
  const profile = {
    id: "nas-01",
    disks: [
      { name: "sda", sizeBytes: 1, serial: "WD-SN123456" },
      { name: "sdb", sizeBytes: 2, serial: "1234" }
    ],
    preferences: {
      quietHours: "22:00-07:00",
      notifyLevel: "high",
      apiKey: "secret-value",
      userToken: "token-value",
      backupPassword: "hunter2",
      maintenanceWindow: "sun-03:00"
    }
  };
  const redacted = redactProfile(profile);
  assert.equal(redacted.disks[0].serial, "*******3456");
  assert.equal(redacted.disks[1].serial, "****");
  assert.deepEqual(redacted.preferences, {
    quietHours: "22:00-07:00",
    notifyLevel: "high",
    maintenanceWindow: "sun-03:00"
  });
  // 入参未被修改。
  assert.equal(profile.disks[0].serial, "WD-SN123456");
  assert.equal(profile.preferences.apiKey, "secret-value");
  const serialized = JSON.stringify(redacted);
  for (const needle of ["apiKey", "userToken", "backupPassword", "secret-value", "token-value", "hunter2"]) {
    assert.equal(serialized.includes(needle), false, `${needle} must not survive redaction`);
  }
  assert.equal(serialized.includes("WD-SN123456"), false);
});

test("store put/get/list round-trips and survives a restart", async () => {
  const fs = createMemoryFs();
  const store = createDeviceProfileStore({ dataDir: DATA_DIR, fs, now: () => STAMP });
  const put = await store.put(baseProfileInput());
  assert.equal(put.ok, true);
  assert.equal(put.created, true);
  assert.deepEqual(put.droppedFields, []);

  const got = await store.get("nas-01");
  assert.equal(got.ok, true);
  assert.equal(got.profile.hostname, "nas-01");
  assert.equal(got.profile.createdAt, STAMP);
  assert.equal(got.profile.disks[0].serial, "*******3456");

  const list = await store.list();
  assert.equal(list.ok, true);
  assert.equal(list.total, 1);
  assert.equal(list.maxProfiles, MAX_PROFILES);

  const parsed = JSON.parse(fs.files.get(FILE_PATH));
  assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
  assert.equal(parsed.updatedAt, STAMP);
  assert.equal(parsed.profiles.length, 1);

  const restarted = createDeviceProfileStore({ dataDir: DATA_DIR, fs });
  const reloaded = await restarted.get("nas-01");
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.profile.hostname, "nas-01");
  assert.equal(reloaded.profile.createdAt, STAMP);
  const state = await restarted.state();
  assert.deepEqual(
    { count: state.count, recovered: state.recovered, persisted: state.persisted, schemaVersion: state.schemaVersion },
    { count: 1, recovered: true, persisted: true, schemaVersion: SCHEMA_VERSION }
  );
});

test("store remove deletes the profile from the file", async () => {
  const fs = createMemoryFs();
  const store = createDeviceProfileStore({ dataDir: DATA_DIR, fs, now: () => STAMP });
  await store.put(baseProfileInput());
  const removed = await store.remove("nas-01");
  assert.deepEqual(removed, { ok: true, removed: true, id: "nas-01" });
  assert.deepEqual(await store.get("nas-01"), { ok: false, reason: "not-found" });
  assert.equal((await store.list()).total, 0);
  assert.deepEqual(JSON.parse(fs.files.get(FILE_PATH)).profiles, []);
  assert.deepEqual(await store.remove("nas-01"), { ok: false, reason: "not-found" });
});

test("store refuses a new profile over MAX_PROFILES but still updates an existing one", async () => {
  const fs = createMemoryFs();
  const store = createDeviceProfileStore({ dataDir: DATA_DIR, fs, now: () => STAMP });
  for (let index = 0; index < MAX_PROFILES; index += 1) {
    const result = await store.put({ id: `nas-${index}`, hostname: `nas-${index}` });
    assert.equal(result.ok, true, `put nas-${index} should succeed`);
  }
  assert.equal((await store.list()).total, MAX_PROFILES);
  const overflow = await store.put({ id: "nas-extra", hostname: "nas-extra" });
  assert.deepEqual(overflow, { ok: false, reason: "profile-limit", limit: MAX_PROFILES });
  const updated = await store.put({ id: "nas-0", hostname: "nas-renamed" });
  assert.equal(updated.ok, true);
  assert.equal(updated.created, false);
  assert.equal((await store.get("nas-0")).profile.hostname, "nas-renamed");
  assert.equal((await store.list()).total, MAX_PROFILES);
});

test("store starts empty and records recovered=false for a corrupt file", async () => {
  const fs = createMemoryFs({ [FILE_PATH]: "{ this is not json" });
  const store = createDeviceProfileStore({ dataDir: DATA_DIR, fs });
  const state = await store.state();
  assert.equal(state.count, 0);
  assert.equal(state.recovered, false);
  assert.equal(state.recoveryReason, "corrupt-file");
  assert.deepEqual((await store.list()).profiles, []);
  // 空库仍然可用：下一次写入把损坏文件替换掉。
  const put = await store.put({ id: "nas-01", hostname: "nas-01" });
  assert.equal(put.ok, true);
  assert.equal((await store.state()).count, 1);
  assert.equal((await store.get("nas-01")).profile.hostname, "nas-01");
});

test("store starts empty and records recovered=false for a schema version mismatch", async () => {
  const fs = createMemoryFs({
    [FILE_PATH]: JSON.stringify({
      schemaVersion: SCHEMA_VERSION + 1,
      updatedAt: STAMP,
      profiles: [{ id: "ghost", hostname: "ghost" }]
    })
  });
  const store = createDeviceProfileStore({ dataDir: DATA_DIR, fs });
  const state = await store.state();
  assert.equal(state.recovered, false);
  assert.equal(state.recoveryReason, "schema-mismatch");
  assert.equal(state.count, 0);
  assert.deepEqual(await store.get("ghost"), { ok: false, reason: "not-found" });
});

test("store skips unreadable profiles but keeps the valid ones", async () => {
  const fs = createMemoryFs({
    [FILE_PATH]: JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      updatedAt: STAMP,
      profiles: [
        { id: "BAD ID", hostname: "bad" },
        { id: "nas-01", hostname: "nas-01" },
        { id: "nas-01", hostname: "duplicate" },
        { id: "nas-02", memoryBytes: -5 }
      ]
    })
  });
  const store = createDeviceProfileStore({ dataDir: DATA_DIR, fs });
  const list = await store.list();
  assert.equal(list.total, 1);
  assert.equal(list.profiles[0].hostname, "nas-01", "the first valid record wins");
  assert.equal((await store.state()).recovered, true);
});

test("store never writes a raw serial or a non-whitelisted preference key", async () => {
  const fs = createMemoryFs();
  const store = createDeviceProfileStore({ dataDir: DATA_DIR, fs, now: () => STAMP });
  const put = await store.put(baseProfileInput({
    disks: [{ name: "sda", sizeBytes: 10, serial: "WD-SN123456" }],
    preferences: {
      quietHours: "22:00-07:00",
      apiKey: "sk-live-should-never-be-written",
      backupPassword: "hunter2"
    }
  }));
  assert.equal(put.ok, true);
  assert.deepEqual(put.droppedFields, ["preferences.apiKey", "preferences.backupPassword"]);
  assert.deepEqual(put.profile.preferences, { quietHours: "22:00-07:00" });

  const raw = fs.files.get(FILE_PATH);
  assert.equal(typeof raw, "string");
  for (const needle of ["WD-SN123456", "sk-live-should-never-be-written", "hunter2", "apiKey", "backupPassword"]) {
    assert.equal(raw.includes(needle), false, `${needle} must not reach the file`);
  }
  assert.equal(raw.includes("*******3456"), true);
  assert.deepEqual(Object.keys(JSON.parse(raw).profiles[0].preferences), ["quietHours"]);

  // 原子写：exclusive 临时文件 + fsync 后 rename + 0600。
  assert.equal(fs.opens.length, 1);
  assert.equal(fs.opens[0].flags, "wx");
  assert.equal(fs.opens[0].mode, 0o600);
  assert.equal(fs.opens[0].path.endsWith(".tmp"), true);
  assert.deepEqual(fs.renames, [[fs.opens[0].path, FILE_PATH]]);
  assert.deepEqual(fs.chmods.at(-1), { path: FILE_PATH, mode: 0o600 });
  assert.equal([...fs.files.keys()].some(key => key.endsWith(".tmp")), false);
});

test("store leaves the previous file intact when persistence fails", async () => {
  const fs = createMemoryFs();
  const first = createDeviceProfileStore({ dataDir: DATA_DIR, fs, now: () => STAMP });
  await first.put({ id: "nas-01", hostname: "nas-01" });
  const before = fs.files.get(FILE_PATH);

  const failingFs = {
    ...fs,
    async open() {
      throw Object.assign(new Error("simulated ENOSPC"), { code: "ENOSPC" });
    }
  };
  const failing = createDeviceProfileStore({ dataDir: DATA_DIR, fs: failingFs });
  const result = await failing.put({ id: "nas-02", hostname: "nas-02" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "persist-failed");
  assert.match(result.message, /simulated ENOSPC/);
  assert.equal(fs.files.get(FILE_PATH), before, "the published file is untouched");
  assert.equal((await failing.list()).total, 1);
  assert.deepEqual(await failing.get("nas-02"), { ok: false, reason: "not-found" });
  assert.equal([...fs.files.keys()].some(key => key.endsWith(".tmp")), false);
});

test("store refuses to write when the existing file cannot be read", async () => {
  const fs = createMemoryFs();
  const failingFs = {
    ...fs,
    async readFile() {
      throw Object.assign(new Error("simulated EACCES"), { code: "EACCES" });
    }
  };
  const store = createDeviceProfileStore({ dataDir: DATA_DIR, fs: failingFs });
  const state = await store.state();
  assert.equal(state.recovered, false);
  assert.equal(state.recoveryReason, "read-failed");
  assert.equal(state.writable, false);
  assert.deepEqual(await store.put({ id: "nas-01", hostname: "nas-01" }), {
    ok: false,
    reason: "store-not-writable"
  });
  assert.equal(fs.files.size, 0, "an unreadable file is never overwritten");
});

test("store works in memory when no dataDir is given", async () => {
  const store = createDeviceProfileStore({ now: () => STAMP });
  const put = await store.put(baseProfileInput());
  assert.equal(put.ok, true);
  assert.equal((await store.get("nas-01")).profile.hostname, "nas-01");
  const state = await store.state();
  assert.equal(state.persisted, false);
  assert.equal(state.fileName, null);
  assert.equal(state.count, 1);
});

test("store persists to a real temporary directory and reloads the file", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-device-profile-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const filePath = join(dataDir, DEVICE_PROFILE_FILE_NAME);
  const store = createDeviceProfileStore({ dataDir, now: () => STAMP });
  const put = await store.put(baseProfileInput({ preferences: { quietHours: "22:00-07:00" } }));
  assert.equal(put.ok, true);

  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
  assert.equal(parsed.profiles[0].id, "nas-01");
  assert.equal(parsed.profiles[0].disks[0].serial, "*******3456");

  const restarted = createDeviceProfileStore({ dataDir });
  const reloaded = await restarted.get("nas-01");
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.profile.hostname, "nas-01");
  assert.equal(reloaded.profile.disks[0].serial, "*******3456");
  assert.equal((await restarted.state()).recovered, true);
});

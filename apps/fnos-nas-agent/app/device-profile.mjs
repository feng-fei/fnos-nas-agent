/**
 * Phase 208 — 设备与用户偏好档案（清单 K03 设备档案、K05 用户偏好、K08 过期信息管理）。
 *
 * K03 原先只实现为一次性的「能力位图」：体检完得出 ready / partial / not-ready，
 * 结果用完即丢。但「这台机器是什么」和「这位用户希望它怎么工作」都是长期有效的
 * 知识，每次重新探测既慢，也依赖设备此刻可达。这个模块把这两类信息变成一份可
 * 持久化、可合并、可判断新鲜度的档案。
 *
 * 这个模块守住的规则：
 *   - 档案只接受白名单字段。未知字段被丢弃并计入 droppedFields，而不是悄悄写盘。
 *   - 磁盘序列号在内存里就只保留后 4 位，落盘前再脱敏一次。
 *   - preferences 里任何名字像密码 / 令牌的键整体删除，原值不会被写出。
 *   - 写文件是原子的：临时文件 → fsync → rename → chmod 0600。
 *   - 文件损坏或 schemaVersion 不符时按空库启动，并把 recovered=false 记进
 *     state()，绝不把损坏内容当成空库再写回去。
 *   - 档案里不保存任何凭据；本模块不做网络访问，也没有第三方依赖。
 */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createSerialWriteQueue } from "./serial-write-queue.mjs";

export const PROFILE_FIELDS = Object.freeze([
  "hostname",
  "model",
  "firmware",
  "kernel",
  "cpuModel",
  "cpuCores",
  "memoryBytes",
  "disks",
  "timezone",
  "locale"
]);

export const PREFERENCE_KEYS = Object.freeze([
  "quietHours",
  "preferredModel",
  "preferredLanguage",
  "notifyLevel",
  "maintenanceWindow"
]);

export const MAX_PROFILES = 50;
export const DEFAULT_STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
export const SCHEMA_VERSION = 1;

export const DEVICE_PROFILE_FILE_NAME = "device-profiles.json";
export const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_PROFILE_ID_LENGTH = 64;
export const MAX_TEXT_LENGTH = 200;
export const MAX_PREFERENCE_VALUE_LENGTH = 200;
export const MAX_DISKS = 64;
export const MAX_DISK_NAME_LENGTH = 100;

const DAY_MS = 24 * 60 * 60 * 1000;
const TEXT_FIELDS = Object.freeze(["hostname", "model", "firmware", "kernel", "cpuModel", "timezone", "locale"]);
// 键名命中任意一个词就整体删除，值一律不看。
const SENSITIVE_PREFERENCE_PATTERN = /pass|token|secret|key/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function toTime(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function toIso(value) {
  const time = toTime(value);
  return time === null ? null : new Date(time).toISOString();
}

function stampFrom(value) {
  return toIso(value) ?? new Date().toISOString();
}

/**
 * 序列号脱敏：只保留后 4 位，其余每一位都换成一个星号。
 * 对已经脱敏的值幂等，因此重复归一到同一份档案不会把星号越叠越多。
 */
function maskSerial(value) {
  const serial = String(value ?? "").trim();
  if (!serial) return "";
  if (serial.length <= 4) return "****";
  return "*".repeat(serial.length - 4) + serial.slice(-4);
}

function normalizeDisks(value) {
  if (value === undefined || value === null) return { ok: true, disks: [] };
  if (!Array.isArray(value)) return { ok: false, reason: "disks-invalid" };
  if (value.length > MAX_DISKS) return { ok: false, reason: "disks-too-many" };
  const disks = [];
  for (const item of value) {
    if (!isPlainObject(item)) return { ok: false, reason: "disk-entry-invalid" };
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name || name.length > MAX_DISK_NAME_LENGTH) {
      return { ok: false, reason: "disk-entry-invalid" };
    }
    if (!Number.isInteger(item.sizeBytes) || item.sizeBytes < 0) {
      return { ok: false, reason: "disk-size-invalid" };
    }
    const disk = { name, sizeBytes: item.sizeBytes };
    if (typeof item.serial === "string" && item.serial.trim()) disk.serial = maskSerial(item.serial);
    disks.push(disk);
  }
  return { ok: true, disks };
}

function normalizePreferences(value, droppedFields) {
  if (value === undefined || value === null) return { ok: true, preferences: {} };
  if (!isPlainObject(value)) return { ok: false, reason: "preferences-invalid" };
  const preferences = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!PREFERENCE_KEYS.includes(key)) {
      droppedFields.push(`preferences.${key}`);
      continue;
    }
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed) preferences[key] = trimmed.slice(0, MAX_PREFERENCE_VALUE_LENGTH);
      continue;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
      preferences[key] = String(raw).slice(0, MAX_PREFERENCE_VALUE_LENGTH);
      continue;
    }
    if (typeof raw === "boolean") {
      preferences[key] = String(raw);
      continue;
    }
    droppedFields.push(`preferences.${key}`);
  }
  return { ok: true, preferences };
}

function cloneProfile(profile) {
  if (!isPlainObject(profile)) return profile;
  const copy = { ...profile };
  if (Array.isArray(copy.disks)) {
    copy.disks = copy.disks.map(disk => (isPlainObject(disk) ? { ...disk } : disk));
  }
  if (isPlainObject(copy.preferences)) copy.preferences = { ...copy.preferences };
  return copy;
}

function sameValue(left, right) {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((item, index) => sameValue(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]));
  }
  return left === right;
}

/**
 * 把一个原始输入归一成一份档案。纯函数，不写任何存储。
 *
 * @param {object} input 档案输入，`id` 可以放在 input.id 或 options.id
 * @param {object} [options]
 * @param {string|Date} [options.now] 时间戳，测试可注入
 * @param {string} [options.id] 显式指定的档案 id，优先于 input.id
 * @returns {{ok: true, profile: object, droppedFields: string[]}
 *          | {ok: false, reason: string, field?: string}}
 */
export function normalizeProfile(input, { now = new Date().toISOString(), id } = {}) {
  if (!isPlainObject(input)) return { ok: false, reason: "invalid-input" };

  const requestedId = typeof id === "string" && id.trim() ? id.trim() : text(input.id).trim();
  if (!PROFILE_ID_PATTERN.test(requestedId)) return { ok: false, reason: "invalid-id" };

  const stamp = stampFrom(now);
  const droppedFields = [];
  const known = new Set(["id", "createdAt", "updatedAt", ...PROFILE_FIELDS, "preferences"]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) droppedFields.push(key);
  }

  const profile = { id: requestedId };

  for (const field of TEXT_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") return { ok: false, reason: "field-type-invalid", field };
    const trimmed = value.trim();
    if (!trimmed) continue;
    profile[field] = trimmed.slice(0, MAX_TEXT_LENGTH);
  }

  if (input.cpuCores !== undefined && input.cpuCores !== null) {
    if (!Number.isInteger(input.cpuCores) || input.cpuCores < 0) {
      return { ok: false, reason: "cpu-cores-invalid", field: "cpuCores" };
    }
    profile.cpuCores = input.cpuCores;
  }

  if (input.memoryBytes !== undefined && input.memoryBytes !== null) {
    if (!Number.isInteger(input.memoryBytes) || input.memoryBytes < 0) {
      return { ok: false, reason: "memory-bytes-invalid", field: "memoryBytes" };
    }
    profile.memoryBytes = input.memoryBytes;
  }

  const disks = normalizeDisks(input.disks);
  if (disks.ok === false) return disks;
  profile.disks = disks.disks;

  const preferences = normalizePreferences(input.preferences, droppedFields);
  if (preferences.ok === false) return preferences;
  profile.preferences = preferences.preferences;

  // 显式给出的时间戳被保留（从磁盘读回的档案要靠它），否则用 now。
  profile.createdAt = toIso(input.createdAt) ?? stamp;
  profile.updatedAt = toIso(input.updatedAt) ?? stamp;

  return { ok: true, profile, droppedFields };
}

/**
 * 把一个补丁合并到已有档案上。
 *
 * 合并语义：对象逐键深合并，数组整体替换，值为 null 表示删除该字段；
 * createdAt 永远保留旧值，updatedAt 取 now。返回值里的 changedFields 只列出
 * 真正变化的字段（preferences 精确到 `preferences.<key>`）。
 *
 * @param {object} existing
 * @param {object} incoming
 * @param {object} [options]
 * @param {string|Date} [options.now]
 * @returns {{profile: object, changedFields: string[], droppedFields: string[]}
 *          | {ok: false, reason: string, field?: string}}
 */
export function mergeProfile(existing, incoming, { now = new Date().toISOString() } = {}) {
  if (!isPlainObject(incoming)) return { ok: false, reason: "invalid-input" };
  const base = isPlainObject(existing) ? existing : {};
  const baseId = text(base.id).trim();
  const incomingId = text(incoming.id).trim();
  if (baseId && incomingId && baseId !== incomingId) {
    return { ok: false, reason: "id-mismatch" };
  }
  const targetId = incomingId || baseId;
  if (!targetId) return { ok: false, reason: "invalid-id" };

  const stamp = stampFrom(now);
  const merged = mergeValues(base, incoming);
  merged.id = targetId;
  if (base.createdAt) merged.createdAt = base.createdAt;
  merged.updatedAt = stamp;

  const normalized = normalizeProfile(merged, { now: stamp, id: targetId });
  if (normalized.ok === false) return normalized;
  const profile = normalized.profile;

  const baseline = normalizeProfile(base, { now: stamp, id: baseId || targetId });
  const before = baseline.ok === false ? { disks: [], preferences: {} } : baseline.profile;

  const changedFields = [];
  for (const field of PROFILE_FIELDS) {
    if (!sameValue(before[field], profile[field])) changedFields.push(field);
  }
  for (const key of PREFERENCE_KEYS) {
    if (!sameValue(before.preferences?.[key], profile.preferences?.[key])) {
      changedFields.push(`preferences.${key}`);
    }
  }

  return { profile, changedFields, droppedFields: normalized.droppedFields };
}

function mergeValues(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (isPlainObject(patch)) {
    const result = isPlainObject(base) ? { ...base } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) {
        delete result[key];
        continue;
      }
      result[key] = mergeValues(result[key], value);
    }
    return result;
  }
  return patch;
}

/**
 * K08：判断档案有多新。缺 updatedAt 或时间戳不可解析时为 unknown，
 * 绝不把「不知道」当成「新鲜」。
 *
 * @param {object} profile
 * @param {object} [options]
 * @param {string|Date} [options.now]
 * @param {number} [options.staleAfterMs]
 * @returns {{state: "fresh"|"stale"|"unknown", ageDays: number|null, staleAfterMs: number}}
 */
export function profileFreshness(profile, { now = new Date().toISOString(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  const threshold = Number.isFinite(staleAfterMs) && staleAfterMs >= 0 ? staleAfterMs : DEFAULT_STALE_AFTER_MS;
  const end = toTime(now) ?? Date.now();
  const updatedAt = isPlainObject(profile) ? profile.updatedAt : null;
  const start = toTime(updatedAt);
  if (start === null) return { state: "unknown", ageDays: null, staleAfterMs: threshold };
  const ageMs = Math.max(0, end - start);
  return {
    state: ageMs > threshold ? "stale" : "fresh",
    ageDays: Math.floor(ageMs / DAY_MS),
    staleAfterMs: threshold
  };
}

/**
 * 脱敏：磁盘序列号只保留后 4 位，preferences 中名字命中敏感模式的键整体删除。
 * 返回新对象，不修改入参。
 *
 * @param {object} profile
 * @returns {object}
 */
export function redactProfile(profile) {
  if (!isPlainObject(profile)) return profile;
  const copy = { ...profile };
  if (Array.isArray(copy.disks)) {
    copy.disks = copy.disks.map(disk => {
      if (!isPlainObject(disk)) return disk;
      const next = { ...disk };
      if (typeof next.serial === "string" && next.serial) next.serial = maskSerial(next.serial);
      else if (next.serial !== undefined) delete next.serial;
      return next;
    });
  }
  if (isPlainObject(copy.preferences)) {
    const preferences = {};
    for (const [key, value] of Object.entries(copy.preferences)) {
      if (SENSITIVE_PREFERENCE_PATTERN.test(key)) continue;
      preferences[key] = value;
    }
    copy.preferences = preferences;
  }
  return copy;
}

/**
 * 档案库。dataDir 为空时是纯内存库；注入 fs 时可用内存实现测试原子写路径。
 *
 * @param {object} [options]
 * @param {string} [options.dataDir] 持久化目录，文件为 <dataDir>/device-profiles.json
 * @param {object|null} [options.fs] 文件系统实现，null 时惰性 import node:fs/promises
 * @param {() => string|Date} [options.now] 时钟
 * @returns {{put: Function, get: Function, list: Function, remove: Function, state: Function}}
 */
export function createDeviceProfileStore({ dataDir = "", fs = null, now = () => new Date().toISOString() } = {}) {
  if (typeof dataDir !== "string") throw new TypeError("dataDir must be a string");
  if (fs !== null && fs !== undefined && !isPlainObject(fs)) throw new TypeError("fs must be an object or null");
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const persistent = dataDir.trim().length > 0;
  const filePath = persistent ? join(dataDir, DEVICE_PROFILE_FILE_NAME) : "";
  const queue = createSerialWriteQueue();

  let profiles = new Map();
  let loaded = false;
  let loading = null;
  let updatedAt = null;
  let recovered = true;
  let recoveryReason = null;
  // 读文件失败（不是「文件不存在」）时不允许写入，否则会用空库覆盖读不懂的旧档案。
  let writable = true;
  let fsApi = fs ?? null;

  async function getFs() {
    if (fsApi) return fsApi;
    const fsModule = await import("node:fs/promises");
    fsApi = {
      open: fsModule.open,
      mkdir: fsModule.mkdir,
      rename: fsModule.rename,
      chmod: fsModule.chmod,
      unlink: fsModule.unlink,
      readFile: fsModule.readFile
    };
    return fsApi;
  }

  function currentStamp() {
    return toIso(now()) ?? new Date().toISOString();
  }

  function load() {
    if (loaded) return Promise.resolve();
    if (loading) return loading;
    loading = (async () => {
      try {
        if (!persistent) return;
        const api = await getFs();
        let raw = "";
        try {
          raw = await api.readFile(filePath, "utf8");
        } catch (error) {
          if (error?.code !== "ENOENT") {
            recovered = false;
            recoveryReason = "read-failed";
            writable = false;
          }
          return;
        }
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // 损坏的文件按空库启动，且不当作「已恢复」。
          recovered = false;
          recoveryReason = "corrupt-file";
          return;
        }
        if (!isPlainObject(parsed) || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.profiles)) {
          recovered = false;
          recoveryReason = "schema-mismatch";
          return;
        }
        const stamp = currentStamp();
        const adopted = new Map();
        for (const item of parsed.profiles.slice(0, MAX_PROFILES)) {
          const result = normalizeProfile(item, { now: stamp });
          if (result.ok === false) continue;
          if (!adopted.has(result.profile.id)) adopted.set(result.profile.id, result.profile);
        }
        profiles = adopted;
        updatedAt = toIso(parsed.updatedAt) ?? null;
      } finally {
        loaded = true;
        loading = null;
      }
    })();
    return loading;
  }

  function serialize(map, stamp) {
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: stamp,
      profiles: [...map.values()].map(cloneProfile)
    };
  }

  async function persist(map, stamp) {
    if (!persistent) {
      updatedAt = stamp;
      return;
    }
    const api = await getFs();
    await api.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const payload = Buffer.from(JSON.stringify(serialize(map, stamp)), "utf8");
    const tempPath = join(dataDir, `.device-profiles-${randomUUID()}.tmp`);
    let handle = null;
    let renamed = false;
    try {
      handle = await api.open(tempPath, "wx", 0o600);
      await handle.writeFile(payload);
      await handle.sync();
      await handle.close();
      handle = null;
      await api.rename(tempPath, filePath);
      renamed = true;
      await api.chmod(filePath, 0o600);
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (!renamed) await api.unlink(tempPath).catch(() => {});
    }
    updatedAt = stamp;
  }

  function put(profile) {
    return queue(async () => {
      await load();
      if (!writable) return { ok: false, reason: "store-not-writable" };
      const stamp = currentStamp();
      const normalized = normalizeProfile(profile, { now: stamp });
      if (normalized.ok === false) {
        return { ok: false, reason: normalized.reason, field: normalized.field };
      }
      const id = normalized.profile.id;
      const existing = profiles.get(id);
      if (!existing && profiles.size >= MAX_PROFILES) {
        return { ok: false, reason: "profile-limit", limit: MAX_PROFILES };
      }
      // 写入前整体脱敏：preferences 里的敏感键在这里被删除，序列号只留后 4 位。
      const record = redactProfile({
        ...normalized.profile,
        createdAt: existing?.createdAt ?? normalized.profile.createdAt,
        updatedAt: stamp
      });
      const next = new Map(profiles);
      next.set(id, record);
      try {
        await persist(next, stamp);
      } catch (error) {
        return { ok: false, reason: "persist-failed", message: error?.message || String(error) };
      }
      profiles = next;
      return {
        ok: true,
        profile: cloneProfile(record),
        created: !existing,
        droppedFields: normalized.droppedFields
      };
    });
  }

  async function get(id) {
    await load();
    const key = text(id).trim();
    const found = profiles.get(key);
    return found ? { ok: true, profile: cloneProfile(found) } : { ok: false, reason: "not-found" };
  }

  async function list() {
    await load();
    const all = [...profiles.values()]
      .map(cloneProfile)
      .sort((left, right) => {
        const order = text(right.updatedAt).localeCompare(text(left.updatedAt));
        return order !== 0 ? order : text(left.id).localeCompare(text(right.id));
      });
    return { ok: true, profiles: all, total: all.length, maxProfiles: MAX_PROFILES };
  }

  function remove(id) {
    return queue(async () => {
      await load();
      if (!writable) return { ok: false, reason: "store-not-writable" };
      const key = text(id).trim();
      if (!profiles.has(key)) return { ok: false, reason: "not-found" };
      const stamp = currentStamp();
      const next = new Map(profiles);
      next.delete(key);
      try {
        await persist(next, stamp);
      } catch (error) {
        return { ok: false, reason: "persist-failed", message: error?.message || String(error) };
      }
      profiles = next;
      return { ok: true, removed: true, id: key };
    });
  }

  async function state() {
    await load();
    return {
      count: profiles.size,
      maxProfiles: MAX_PROFILES,
      schemaVersion: SCHEMA_VERSION,
      persisted: persistent,
      fileName: persistent ? DEVICE_PROFILE_FILE_NAME : null,
      updatedAt,
      recovered,
      recoveryReason,
      writable
    };
  }

  return { put, get, list, remove, state };
}

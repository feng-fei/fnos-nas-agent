import { createHash, randomBytes } from "node:crypto";
import { extractZipEntry, inspectZipArchive, MAX_ARCHIVE_BYTES, saveQuarantinedArchive } from "./skill-archives.mjs";
import { isPreviewableSkillTextPath, MAX_SKILL_SOURCE_PREVIEW_BYTES } from "./skill-source-review.mjs";
import { inspectSkillManifest } from "./skill-manifest.mjs";
import { parseSkillPackage } from "./skill-package.mjs";
import { mkdir, open, readFile, writeFile, rename, chmod, unlink, lstat } from "node:fs/promises";
import { createSerialWriteQueue } from "./serial-write-queue.mjs";
import { resolve, sep } from "node:path";
import { basename, join } from "node:path";

const STATES = new Set(["pending_review", "approved", "enabled", "disabled", "rejected"]);
const TRANSITIONS = {
  pending_review: new Set(["approved", "rejected"]),
  approved: new Set(["enabled", "disabled", "rejected"]),
  enabled: new Set(["disabled"]),
  disabled: new Set(["approved", "rejected"]),
  rejected: new Set()
};
const MAX_RECORDS = 500;
const MAX_NAME = 100;
const MAX_NOTE = 500;

function normalizeManifestReview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const statuses = new Set(["needs_review", "manifest_parsed"]);
  return {
    status: statuses.has(value.status) ? value.status : "needs_review",
    manifestFound: value.manifestFound === true,
    entryPath: typeof value.entryPath === "string" ? value.entryPath.slice(0, 1024) : null,
    name: typeof value.name === "string" ? value.name.slice(0, 100) : null,
    description: typeof value.description === "string" ? value.description.slice(0, 1000) : null,
    findings: Array.isArray(value.findings) ? value.findings.filter(x => typeof x === "string").slice(0, 20).map(x => x.slice(0, 100)) : [],
    archiveEntryCount: Number.isSafeInteger(value.archiveEntryCount) ? value.archiveEntryCount : null,
    sourceFilesScanned: Number.isSafeInteger(value.sourceFilesScanned) ? value.sourceFilesScanned : 0,
    sourceBytesScanned: Number.isSafeInteger(value.sourceBytesScanned) ? value.sourceBytesScanned : 0,
    sourceReviewIncomplete: value.sourceReviewIncomplete === true,
    // Phase 136: only the server may claim that it reviewed an archive. A
    // client-declared review carries no marker, so it can never be stored as
    // a server verdict.
    reviewedBy: value.reviewedBy === "server" ? "server" : null,
    archiveSha256: typeof value.archiveSha256 === "string" && /^[a-f0-9]{64}$/.test(value.archiveSha256) ? value.archiveSha256 : null
  };
}

/**
 * Phase 187: the archive structure is reviewed with the same discipline as the
 * manifest. The value stored here is a bounded summary of a server-side parse;
 * a parse that could not be computed is stored as null and never as a pass.
 */
function normalizePackageReview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const statuses = new Set(["ok", "incomplete", "invalid"]);
  const findings = Array.isArray(value.findings)
    ? value.findings.filter(item => item && typeof item.rule === "string")
        .slice(0, 8).map(item => ({ rule: item.rule.slice(0, 60), severity: item.severity === "error" ? "error" : "warning" }))
    : [];
  const count = (key) => Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : 0;
  return {
    status: statuses.has(value.status) ? value.status : "invalid",
    references: count("references"),
    scripts: count("scripts"),
    tests: count("tests"),
    findings,
    reviewedBy: value.reviewedBy === "server" ? "server" : null
  };
}

/** Parses the quarantined bytes; a parser failure yields no verdict at all. */
export function reviewSkillPackageBuffer(buffer) {
  try {
    const report = parseSkillPackage(buffer);
    return normalizePackageReview({
      status: report.status,
      references: Array.isArray(report.references) ? report.references.length : 0,
      scripts: Array.isArray(report.scripts) ? report.scripts.length : 0,
      tests: Array.isArray(report.tests) ? report.tests.length : 0,
      findings: Array.isArray(report.findings) ? report.findings : [],
      reviewedBy: "server"
    });
  } catch {
    return null;
  }
}

export function createSkillStore(dataDir, { fs: storageFs = { mkdir, readFile, writeFile, rename, chmod, unlink, open } } = {}) {
  const file = join(dataDir, "skills.json");
  let records = [];
  // Set when the inventory could not be read and the service continued with an empty
  // list. The operator can see the difference between a normal and a degraded start.
  let degradedState = false;
  const enqueueWrite = createSerialWriteQueue();
  const enqueueMutation = createSerialWriteQueue();

  async function syncDirectory(directory) {
    // Directory fsync is not available on every platform; the rename itself stays atomic.
    let handle = null;
    try {
      handle = await open(directory, "r");
      await handle.sync();
    } catch {
      // best effort only
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function writeInventoryFile(target, data) {
    // Durable write: the bytes reach the disk before the atomic rename publishes them.
    // Injected filesystems without file handles fall back to a plain write.
    if (typeof storageFs.open === "function") {
      const handle = await storageFs.open(target, "wx", 0o600);
      try {
        await handle.writeFile(data, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    }
    await storageFs.writeFile(target, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }

  async function persist() {
    return enqueueWrite(async () => {
      const snapshot = JSON.stringify(records);
      await storageFs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      const tmp = file + "." + randomBytes(8).toString("hex") + ".tmp";
      try {
        await writeInventoryFile(tmp, snapshot + "\n");
        await storageFs.chmod(tmp, 0o600);
        await storageFs.rename(tmp, file);
        await syncDirectory(dataDir);
      } catch (error) {
        await storageFs.unlink(tmp).catch(() => {});
        throw error;
      }
    });
  }

  async function quarantineInventory() {
    // A damaged inventory must never block startup: keep the bytes for forensics and
    // continue with an empty Skill list.
    degradedState = true;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = join(dataDir, basename(file) + ".corrupt-" + stamp + ".json");
    try {
      await storageFs.rename(file, backup);
      console.error(`[skills] Corrupt Skill inventory was quarantined as ${basename(backup)}; the service continues with an empty Skill list.`);
    } catch (error) {
      console.error(`[skills] Corrupt Skill inventory could not be moved aside (${error?.message || "unknown error"}); the service continues with an empty Skill list.`);
    }
    records = [];
  }

  async function load() {
    let raw = null;
    try {
      raw = await storageFs.readFile(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        degradedState = true;
        throw new Error("Skill inventory could not be loaded safely");
      }
      return;
    }
    let value = null;
    try {
      value = JSON.parse(raw);
      if (!Array.isArray(value) || value.length > MAX_RECORDS) throw new Error("invalid store");
    } catch (error) {
      console.error(`[skills] Skill inventory could not be parsed (${error?.message || "unknown error"}); it is quarantined and the service continues with an empty Skill list.`);
      await quarantineInventory();
      return;
    }
    records = value.filter(item =>
      item && typeof item.id === "string" && typeof item.name === "string" &&
      STATES.has(item.state) && typeof item.archiveSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(item.archiveSha256)
    ).map(item => ({
      id: item.id, name: item.name, version: item.version,
      sourceLabel: item.sourceLabel, importedAt: item.importedAt,
      archiveSha256: item.archiveSha256, state: item.state,
      quarantineFile: typeof item.quarantineFile === "string" ? item.quarantineFile : "",
      archiveSizeBytes: Number.isSafeInteger(item.archiveSizeBytes) ? item.archiveSizeBytes : null,
      archiveEntryCount: Number.isSafeInteger(item.archiveEntryCount) ? item.archiveEntryCount : null,
      declaredUncompressedBytes: Number.isSafeInteger(item.declaredUncompressedBytes) ? item.declaredUncompressedBytes : null,
      declaredCapabilities: Array.isArray(item.declaredCapabilities) ? item.declaredCapabilities.slice(0, 20) : [],
      manifestReview: normalizeManifestReview(item.manifestReview),
      packageReview: normalizePackageReview(item.packageReview),
      reviewNote: typeof item.reviewNote === "string" ? item.reviewNote.slice(0, MAX_NOTE) : "",
      reviewedAt: item.reviewedAt || null
    }));
    await reviewLegacyRecords();
  }

  /**
   * Phase 136 migration: an installation that was upgraded from a build
   * without server-side reviews still holds records whose verdict was never
   * computed by the server. The verdict is recomputed here from the very same
   * quarantined bytes, so an upgraded NAS keeps its Skills usable instead of
   * silently losing the ability to install the official CLI.
   */
  async function reviewLegacyRecords() {
    let reviewed = 0;
    for (const record of records) {
      if (record.manifestReview?.reviewedBy === "server") continue;
      const quarantineFile = record.quarantineFile || ("skill-quarantine/" + record.archiveSha256 + ".zip");
      let quarantined = null;
      try {
        quarantined = await readQuarantinedArchiveForReview({ archiveSha256: record.archiveSha256, quarantineFile });
      } catch {
        // The quarantined archive is gone: the record stays unreviewed and can
        // neither be approved nor installed. It is never given a fake pass.
        continue;
      }
      if (!quarantined) continue;
      try {
        record.manifestReview = normalizeManifestReview({
          ...inspectSkillManifest(quarantined.buffer),
          reviewedBy: "server",
          archiveSha256: record.archiveSha256
        });
        record.packageReview = reviewSkillPackageBuffer(quarantined.buffer);
        record.reviewedAt = new Date().toISOString();
        reviewed++;
      } catch {
        // A review that cannot be computed stays absent.
      }
    }
    if (!reviewed) return;
    try {
      await persist();
    } catch (error) {
      console.error(`[skills] The server-side review of ${reviewed} upgraded Skill record(s) could not be saved (${error?.message || "unknown error"}); the records stay unreviewed.`);
    }
  }

  function list({ limit = 50, offset = 0, state, q = "" } = {}) {
    const query = typeof q === "string" ? q.trim().slice(0, 100).toLocaleLowerCase() : "";
    const filtered = records.filter(item => {
      if (state && item.state !== state) return false;
      if (!query) return true;
      const searchable = [
        item.name, item.version, item.sourceLabel, item.archiveSha256, item.reviewNote,
        item.manifestReview?.name, item.manifestReview?.description,
        ...(item.declaredCapabilities || [])
      ].filter(value => typeof value === "string").join("\\n").toLocaleLowerCase();
      return searchable.includes(query);
    });
    return { total: filtered.length, limit, offset, skills: filtered.slice(offset, offset + limit).map(item => ({ ...item, declaredCapabilities: [...item.declaredCapabilities] })) };
  }

  async function register(request) {
    return enqueueMutation(async () => {
    if (records.length >= MAX_RECORDS) throw Object.assign(new Error("Skill inventory limit reached"), { statusCode: 409 });
    if (!request || typeof request.name !== "string" || !request.name.trim() || request.name.trim().length > MAX_NAME)
      throw Object.assign(new Error("name must contain 1 to 100 characters"), { statusCode: 400 });
    if (typeof request.archiveSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(request.archiveSha256))
      throw Object.assign(new Error("archiveSha256 must be a SHA-256 hex digest"), { statusCode: 400 });
    const name = request.name.trim();
    // Phase 136: the Skill name is the identity of the Skill, so it is unique
    // across the whole inventory regardless of letter case.
    if (records.some(item => item.name.toLowerCase() === name.toLowerCase()))
      throw Object.assign(new Error("Skill name already registered"), { statusCode: 409 });

    // Phase 136: the client never decides where the archive lives and never
    // decides the review outcome. Both are derived from the archive digest and
    // computed by the server from the quarantined bytes themselves.
    const archiveSha256 = request.archiveSha256.toLowerCase();
    const quarantineFile = "skill-quarantine/" + archiveSha256 + ".zip";
    const quarantined = await readQuarantinedArchiveForReview({ archiveSha256, quarantineFile });
    let manifestReview = null;
    if (quarantined) {
      const buffer = quarantined.buffer;
      try {
        manifestReview = {
          ...inspectSkillManifest(buffer),
          reviewedBy: "server",
          archiveSha256
        };
      } catch {
        // A review that could not be computed is stored as "no review"; it is
        // never replaced by a fabricated pass.
        manifestReview = null;
      }
    }
    const packageReview = quarantined ? reviewSkillPackageBuffer(quarantined.buffer) : null;
    const input = {
      name,
      version: request.version,
      sourceLabel: request.sourceLabel,
      archiveSha256,
      quarantineFile,
      archiveSizeBytes: quarantined ? quarantined.buffer.length : null,
      archiveEntryCount: quarantined ? quarantined.archive.entryCount : null,
      declaredUncompressedBytes: quarantined ? quarantined.archive.declaredUncompressedBytes : null,
      declaredCapabilities: request.declaredCapabilities,
      manifestReview,
      packageReview
    };
    const caps = Array.isArray(input.declaredCapabilities)
      ? input.declaredCapabilities.filter(x => typeof x === "string").slice(0, 20).map(x => x.slice(0, 80))
      : [];
    const record = {
      id: randomBytes(12).toString("hex"),
      name: input.name,
      version: typeof input.version === "string" ? input.version.slice(0, 40) : "",
      sourceLabel: typeof input.sourceLabel === "string" ? input.sourceLabel.slice(0, 100) : "",
      importedAt: new Date().toISOString(),
      archiveSha256: input.archiveSha256,
      quarantineFile: input.quarantineFile,
      archiveSizeBytes: Number.isSafeInteger(input.archiveSizeBytes) ? input.archiveSizeBytes : null,
      archiveEntryCount: Number.isSafeInteger(input.archiveEntryCount) ? input.archiveEntryCount : null,
      declaredUncompressedBytes: Number.isSafeInteger(input.declaredUncompressedBytes) ? input.declaredUncompressedBytes : null,
      state: "pending_review",
      declaredCapabilities: caps,
      manifestReview: normalizeManifestReview(input.manifestReview),
      packageReview: normalizePackageReview(input.packageReview),
      reviewNote: "",
      reviewedAt: null
    };
    records.push(record);
    try { await persist(); } catch { records = records.filter(item => item.id !== record.id); throw Object.assign(new Error("Unable to save Skill metadata securely"), { statusCode: 500 }); }
    return { ...record, declaredCapabilities: [...record.declaredCapabilities] };
    });
  }

  function skillById(id) {
    if (typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id))
      throw Object.assign(new Error("Invalid Skill ID"), { statusCode: 400 });
    const item = records.find(record => record.id === id);
    if (!item) throw Object.assign(new Error("Skill not found"), { statusCode: 404 });
    if (!item.quarantineFile) throw Object.assign(new Error("Skill has no quarantined archive to inspect"), { statusCode: 409 });
    return item;
  }

  /**
   * Phase 136: reads the archive a registration points at, using the same
   * safety rules as readQuarantinedArchive. A missing archive is refused with
   * 409 because a Skill without quarantined bytes cannot be reviewed; an
   * archive that exists but cannot be reviewed safely yields no review at all
   * instead of a fabricated one.
   */
  async function readQuarantinedArchiveForReview(item) {
    const quarantineRoot = resolve(dataDir, "skill-quarantine");
    const archivePath = resolve(dataDir, item.quarantineFile);
    const expectedPath = resolve(quarantineRoot, item.archiveSha256 + ".zip");
    if (archivePath !== expectedPath || !archivePath.startsWith(quarantineRoot + sep) || !archivePath.endsWith(".zip"))
      throw Object.assign(new Error("Quarantined archive path is invalid"), { statusCode: 500 });
    let rootInfo, archiveInfo;
    try {
      [rootInfo, archiveInfo] = await Promise.all([lstat(quarantineRoot), lstat(archivePath)]);
    } catch {
      throw Object.assign(new Error("A quarantined Skill archive is required to register a Skill"), { statusCode: 409 });
    }
    try {
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() ||
          archiveInfo.isSymbolicLink() || !archiveInfo.isFile())
        throw Object.assign(new Error("Quarantined archive filesystem type is unsafe"), { statusCode: 500 });
      if (archiveInfo.size > MAX_ARCHIVE_BYTES)
        throw Object.assign(new Error("Quarantined archive exceeds the inspection size limit"), { statusCode: 413 });
      const buffer = await readFile(archivePath);
      if (buffer.length > MAX_ARCHIVE_BYTES)
        throw Object.assign(new Error("Quarantined archive exceeds the inspection size limit"), { statusCode: 413 });
      const digest = createHash("sha256").update(buffer).digest("hex");
      if (digest !== item.archiveSha256)
        throw Object.assign(new Error("Quarantined archive integrity check failed"), { statusCode: 500 });
      return { buffer, archive: inspectZipArchive(buffer) };
    } catch {
      // The archive exists but could not be reviewed. The record is stored
      // without a review, so it can neither be approved nor installed.
      return null;
    }
  }

  async function readQuarantinedArchive(item) {
    const quarantineRoot = resolve(dataDir, "skill-quarantine");
    const archivePath = resolve(dataDir, item.quarantineFile);
    const expectedPath = resolve(quarantineRoot, item.archiveSha256 + ".zip");
    if (archivePath !== expectedPath || !archivePath.startsWith(quarantineRoot + sep) || !archivePath.endsWith(".zip"))
      throw Object.assign(new Error("Quarantined archive path is invalid"), { statusCode: 500 });
    let rootInfo, archiveInfo;
    try {
      [rootInfo, archiveInfo] = await Promise.all([lstat(quarantineRoot), lstat(archivePath)]);
    } catch {
      throw Object.assign(new Error("Quarantined archive is unavailable"), { statusCode: 404 });
    }
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() ||
        archiveInfo.isSymbolicLink() || !archiveInfo.isFile())
      throw Object.assign(new Error("Quarantined archive filesystem type is unsafe"), { statusCode: 500 });
    if (archiveInfo.size > MAX_ARCHIVE_BYTES)
      throw Object.assign(new Error("Quarantined archive exceeds the inspection size limit"), { statusCode: 413 });
    const buffer = await readFile(archivePath);
    if (buffer.length > MAX_ARCHIVE_BYTES)
      throw Object.assign(new Error("Quarantined archive exceeds the inspection size limit"), { statusCode: 413 });
    const digest = createHash("sha256").update(buffer).digest("hex");
    if (digest !== item.archiveSha256)
      throw Object.assign(new Error("Quarantined archive integrity check failed"), { statusCode: 500 });
    return { buffer, archive: inspectZipArchive(buffer) };
  }

  async function listSourceFiles(id, { limit = 100, offset = 0 } = {}) {
    const item = skillById(id);
    const boundedLimit = Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 100;
    const boundedOffset = Number.isInteger(offset) ? Math.min(10000, Math.max(0, offset)) : 0;
    const { archive } = await readQuarantinedArchive(item);
    const files = archive.entries
      .filter(entry => !entry.name.endsWith("/") && isPreviewableSkillTextPath(entry.name))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      .map(entry => ({
        path: entry.name,
        sizeBytes: entry.uncompressedSize,
        previewable: entry.uncompressedSize <= MAX_SKILL_SOURCE_PREVIEW_BYTES
      }));
    return {
      skillId: item.id, name: item.name, total: files.length,
      limit: boundedLimit, offset: boundedOffset,
      maxPreviewBytes: MAX_SKILL_SOURCE_PREVIEW_BYTES,
      files: files.slice(boundedOffset, boundedOffset + boundedLimit)
    };
  }

  async function previewSourceFile(id, path) {
    if (typeof path !== "string" || !path.trim() || path.length > 1024 ||
        /[\x00-\x1f\x7f]/.test(path))
      throw Object.assign(new Error("Provide a valid archive file path"), { statusCode: 400 });
    const item = skillById(id);
    const { buffer, archive } = await readQuarantinedArchive(item);
    const entry = archive.entries.find(candidate => candidate.name === path);
    if (!entry || entry.name.endsWith("/"))
      throw Object.assign(new Error("Source file not found in this archive"), { statusCode: 404 });
    if (!isPreviewableSkillTextPath(entry.name))
      throw Object.assign(new Error("Preview is limited to recognized text/source files"), { statusCode: 415 });
    if (entry.uncompressedSize > MAX_SKILL_SOURCE_PREVIEW_BYTES)
      throw Object.assign(new Error("Source preview is limited to 64 KiB per file"), { statusCode: 413 });
    let data;
    try { data = extractZipEntry(buffer, entry.name, MAX_SKILL_SOURCE_PREVIEW_BYTES); }
    catch (error) {
      throw Object.assign(new Error("Unable to read this validated source file"), {
        statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : 400
      });
    }
    let content;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(data); }
    catch { throw Object.assign(new Error("Preview supports UTF-8 text files only"), { statusCode: 415 }); }
    return {
      skillId: item.id, name: item.name, path: entry.name,
      bytes: data.length, content,
      note: "Read from quarantine in memory only; not extracted to disk or executed."
    };
  }

  async function importArchive(input, buffer) {
    // Phase 136: the quarantine write and the review are one server-side
    // operation. The registration itself reads the stored archive back and
    // computes the review, so both import paths agree by construction.
    const archive = await saveQuarantinedArchive(dataDir, buffer);
    const record = await register({
      name: input.name, version: input.version, sourceLabel: input.sourceLabel,
      archiveSha256: archive.sha256,
      archiveSizeBytes: archive.sizeBytes, archiveEntryCount: archive.entryCount,
      declaredUncompressedBytes: archive.declaredUncompressedBytes,
      declaredCapabilities: input.declaredCapabilities
    });
    return { ...record, archiveEntries: archive.entries };
  }

  async function remove(id) {
    return enqueueMutation(async () => {
    const index = records.findIndex(record => record.id === id);
    if (index < 0) throw Object.assign(new Error("Skill not found"), { statusCode: 404 });
    const item = records[index];
    if (item.state !== "rejected") throw Object.assign(new Error("Only rejected Skills can be removed; reject it during review first"), { statusCode: 409 });
    const archivePath = item.quarantineFile ? resolve(dataDir, item.quarantineFile) : "";
    const quarantineRoot = resolve(dataDir, "skill-quarantine");
    if (archivePath && !(archivePath.startsWith(quarantineRoot + sep) && archivePath.endsWith(".zip"))) {
      throw Object.assign(new Error("Quarantined archive path is invalid"), { statusCode: 500 });
    }
    records.splice(index, 1);
    try { await persist(); }
    catch {
      records.splice(index, 0, item);
      throw Object.assign(new Error("Unable to save Skill inventory securely"), { statusCode: 500 });
    }
    if (archivePath && !records.some(record => record.archiveSha256 === item.archiveSha256)) {
      try {
        const quarantineInfo = await lstat(quarantineRoot);
        const archiveInfo = await lstat(archivePath);
        if (quarantineInfo.isSymbolicLink() || !quarantineInfo.isDirectory() ||
            archiveInfo.isSymbolicLink() || !archiveInfo.isFile()) {
          return { removed: true, archiveRemoved: false, warning: "Metadata removed; archive was not deleted because its filesystem type was unsafe." };
        }
        await unlink(archivePath);
      } catch (error) {
        if (error.code !== "ENOENT") return { removed: true, archiveRemoved: false, warning: "Metadata removed; quarantined archive cleanup failed." };
      }
      return { removed: true, archiveRemoved: true };
    }
    return { removed: true, archiveRemoved: false };
    });
  }

  async function transition(id, input) {
    return enqueueMutation(async () => {
    const item = records.find(record => record.id === id);
    if (!item) throw Object.assign(new Error("Skill not found"), { statusCode: 404 });
    const target = input?.state;
    if (!STATES.has(target) || !TRANSITIONS[item.state].has(target))
      throw Object.assign(new Error("Invalid Skill state transition"), { statusCode: 409 });
    // Phase 136: a Skill is approved only after the server itself reviewed
    // the quarantined archive. A record without a server review stays in
    // review, whatever the client asks for.
    if (item.state === "pending_review" && target === "approved" &&
        !(item.manifestReview && item.manifestReview.reviewedBy === "server")) {
      throw Object.assign(new Error("A server-side static review is required before approving this Skill"), { statusCode: 409 });
    }
    const old = { ...item, declaredCapabilities: [...item.declaredCapabilities] };
    item.state = target;
    item.reviewNote = typeof input.note === "string" ? input.note.slice(0, MAX_NOTE) : "";
    item.reviewedAt = new Date().toISOString();
    try { await persist(); } catch {
      Object.assign(item, old);
      throw Object.assign(new Error("Unable to save Skill state securely"), { statusCode: 500 });
    }
    return { ...item, declaredCapabilities: [...item.declaredCapabilities] };
    });
  }

  return { load, list, register, importArchive, listSourceFiles, previewSourceFile, transition, remove, degraded: () => degradedState };
}

export const skillStates = [...STATES];

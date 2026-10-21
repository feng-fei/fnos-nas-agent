import { randomBytes } from "node:crypto";
import { saveQuarantinedArchive } from "./skill-archives.mjs";
import { inspectSkillManifest } from "./skill-manifest.mjs";
import { mkdir, readFile, writeFile, rename, chmod, unlink, lstat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { join } from "node:path";

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
    sourceReviewIncomplete: value.sourceReviewIncomplete === true
  };
}

export function createSkillStore(dataDir) {
  const file = join(dataDir, "skills.json");
  let records = [];
  let queue = Promise.resolve();

  async function persist() {
    const snapshot = JSON.stringify(records);
    queue = queue.then(async () => {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const tmp = file + ".tmp";
      await writeFile(tmp, snapshot + "\n", { encoding: "utf8", mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, file);
    });
    return queue;
  }

  async function load() {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (!Array.isArray(value) || value.length > MAX_RECORDS) throw new Error("invalid store");
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
        reviewNote: typeof item.reviewNote === "string" ? item.reviewNote.slice(0, MAX_NOTE) : "",
        reviewedAt: item.reviewedAt || null
      }));
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("Skill inventory could not be loaded safely");
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

  async function register(input) {
    if (records.length >= MAX_RECORDS) throw Object.assign(new Error("Skill inventory limit reached"), { statusCode: 409 });
    if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > MAX_NAME)
      throw Object.assign(new Error("name must contain 1 to 100 characters"), { statusCode: 400 });
    if (typeof input.archiveSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(input.archiveSha256))
      throw Object.assign(new Error("archiveSha256 must be a SHA-256 hex digest"), { statusCode: 400 });
    const name = input.name.trim();
    if (records.some(item => item.name.toLowerCase() === name.toLowerCase() && item.archiveSha256 === input.archiveSha256.toLowerCase()))
      throw Object.assign(new Error("Skill archive already registered"), { statusCode: 409 });
    const caps = Array.isArray(input.declaredCapabilities)
      ? input.declaredCapabilities.filter(x => typeof x === "string").slice(0, 20).map(x => x.slice(0, 80))
      : [];
    const record = {
      id: randomBytes(12).toString("hex"),
      name,
      version: typeof input.version === "string" ? input.version.slice(0, 40) : "",
      sourceLabel: typeof input.sourceLabel === "string" ? input.sourceLabel.slice(0, 100) : "",
      importedAt: new Date().toISOString(),
      archiveSha256: input.archiveSha256.toLowerCase(),
      quarantineFile: typeof input.quarantineFile === "string" ? input.quarantineFile : "",
      archiveSizeBytes: Number.isSafeInteger(input.archiveSizeBytes) ? input.archiveSizeBytes : null,
      archiveEntryCount: Number.isSafeInteger(input.archiveEntryCount) ? input.archiveEntryCount : null,
      declaredUncompressedBytes: Number.isSafeInteger(input.declaredUncompressedBytes) ? input.declaredUncompressedBytes : null,
      state: "pending_review",
      declaredCapabilities: caps,
      manifestReview: normalizeManifestReview(input.manifestReview),
      reviewNote: "",
      reviewedAt: null
    };
    records.push(record);
    try { await persist(); } catch { records = records.filter(item => item.id !== record.id); throw Object.assign(new Error("Unable to save Skill metadata securely"), { statusCode: 500 }); }
    return { ...record, declaredCapabilities: [...record.declaredCapabilities] };
  }

  async function importArchive(input, buffer) {
    const manifestReview = inspectSkillManifest(buffer);
    const archive = await saveQuarantinedArchive(dataDir, buffer);
    const record = await register({
      name: input.name, version: input.version, sourceLabel: input.sourceLabel,
      archiveSha256: archive.sha256, quarantineFile: archive.quarantineFile,
      archiveSizeBytes: archive.sizeBytes, archiveEntryCount: archive.entryCount,
      declaredUncompressedBytes: archive.declaredUncompressedBytes,
      declaredCapabilities: input.declaredCapabilities,
      manifestReview
    });
    return { ...record, archiveEntries: archive.entries };
  }

  async function remove(id) {
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
  }

  async function transition(id, input) {
    const item = records.find(record => record.id === id);
    if (!item) throw Object.assign(new Error("Skill not found"), { statusCode: 404 });
    const target = input?.state;
    if (!STATES.has(target) || !TRANSITIONS[item.state].has(target))
      throw Object.assign(new Error("Invalid Skill state transition"), { statusCode: 409 });
    const old = { ...item, declaredCapabilities: [...item.declaredCapabilities] };
    item.state = target;
    item.reviewNote = typeof input.note === "string" ? input.note.slice(0, MAX_NOTE) : "";
    item.reviewedAt = new Date().toISOString();
    try { await persist(); } catch {
      Object.assign(item, old);
      throw Object.assign(new Error("Unable to save Skill state securely"), { statusCode: 500 });
    }
    return { ...item, declaredCapabilities: [...item.declaredCapabilities] };
  }

  return { load, list, register, importArchive, transition, remove };
}

export const skillStates = [...STATES];

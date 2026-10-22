import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillStore } from "../apps/fnos-nas-agent/app/skills.mjs";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a small stored-mode ZIP archive that satisfies the server archive checks. */
function makeZip(entries) {
  const localParts = [], centralParts = [];
  let localOffset = 0, centralSize = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + data.length;
    centralSize += central.length + name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

/**
 * Phase 136: a Skill can only be registered when the quarantined archive is
 * already on disk, so the archive bytes are written into the quarantine
 * directory under their own SHA-256 digest before the registration.
 */
async function quarantineArchive(dataDir, archive) {
  const digest = createHash("sha256").update(archive).digest("hex");
  await mkdir(join(dataDir, "skill-quarantine"), { recursive: true });
  await writeFile(join(dataDir, "skill-quarantine", digest + ".zip"), archive);
  return digest;
}

const SAMPLE_MANIFEST = "---\nname: sample-skill\ndescription: A minimal read-only Skill used by the Skill metadata tests\n---\nOnly reads files.\n";
const OFFICIAL_MANIFEST = "---\nname: official-fnOS\ndescription: Manage NAS files\n---\nReads diagnostics only.\n";
const HELPER_MANIFEST = "---\nname: photo-helper\ndescription: Reads image metadata\n---\nReads image metadata only.\n";

test("Skill metadata persists and lifecycle transitions fail closed", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-agent-skills-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createSkillStore(dir);
  await store.load();

  const archive = makeZip([{ name: "SKILL.md", data: SAMPLE_MANIFEST }]);
  const digest = await quarantineArchive(dir, archive);
  const record = await store.register({
    name: "sample-skill",
    version: "1.2.3",
    sourceLabel: "manual metadata",
    archiveSha256: digest,
    declaredCapabilities: ["read-only"]
  });
  assert.equal(record.state, "pending_review");
  assert.match(record.id, /^[a-f0-9]{24}$/);
  assert.equal((await stat(join(dir, "skills.json"))).mode & 0o777, 0o600);
  assert.equal(store.list().total, 1);

  await assert.rejects(store.transition(record.id, { state: "enabled" }), { statusCode: 409 });
  await store.transition(record.id, { state: "approved", note: "reviewed" });
  await store.transition(record.id, { state: "enabled" });
  await store.transition(record.id, { state: "disabled" });
  await store.transition(record.id, { state: "approved" });
  await store.transition(record.id, { state: "rejected" });
  await assert.rejects(store.transition(record.id, { state: "approved" }), { statusCode: 409 });

  const reloaded = createSkillStore(dir);
  await reloaded.load();
  const persisted = reloaded.list().skills[0];
  assert.equal(persisted.state, "rejected");
  assert.equal(persisted.archiveSha256, digest);
  assert.equal(persisted.reviewNote, "");
  const raw = await readFile(join(dir, "skills.json"), "utf8");
  assert.equal(raw.includes("payload"), false);
});

test("Skill registration validates digest and bounds metadata", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-agent-skills-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createSkillStore(dir);
  await store.load();
  await assert.rejects(store.register({ name: "../bad", archiveSha256: "not-a-hash" }), { statusCode: 400 });
  await assert.rejects(store.register({ name: "", archiveSha256: "a".repeat(64) }), { statusCode: 400 });
  const archive = makeZip([{ name: "SKILL.md", data: SAMPLE_MANIFEST }]);
  const digest = await quarantineArchive(dir, archive);
  const item = await store.register({ name: "ok", archiveSha256: digest.toUpperCase(), declaredCapabilities: ["x".repeat(200)] });
  assert.equal(item.archiveSha256, digest);
  assert.equal(item.declaredCapabilities[0].length, 80);
});

test("Skill inventory search matches metadata and capabilities before applying pagination", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-agent-skills-search-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createSkillStore(dir);
  await store.load();
  const officialDigest = await quarantineArchive(dir, makeZip([{ name: "SKILL.md", data: OFFICIAL_MANIFEST }]));
  const helperDigest = await quarantineArchive(dir, makeZip([{ name: "SKILL.md", data: HELPER_MANIFEST }]));
  const first = await store.register({
    name: "Official fnOS",
    version: "2.0.0",
    sourceLabel: "official package",
    archiveSha256: officialDigest,
    declaredCapabilities: ["read-only", "system diagnostics"],
    manifestReview: { name: "fnos", description: "Manage NAS files" }
  });
  await store.register({
    name: "Photo Helper",
    version: "1.1.0",
    sourceLabel: "community",
    archiveSha256: helperDigest,
    declaredCapabilities: ["image metadata"]
  });
  assert.equal(store.list({ q: "OFFICIAL" }).total, 1);
  assert.equal(store.list({ q: "diagnostics" }).skills[0].id, first.id);
  assert.equal(store.list({ q: "manage nas files" }).total, 1);
  assert.equal(store.list({ q: "official", state: "enabled" }).total, 0);
  assert.equal(store.list({ q: "community" }).total, 1);
  assert.equal(store.list({ q: "a", limit: 1, offset: 1 }).skills.length, 1);
  assert.equal(store.list({ q: "x".repeat(101) }).total, 0);
});

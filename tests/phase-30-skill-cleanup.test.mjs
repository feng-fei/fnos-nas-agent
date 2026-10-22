import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
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

const CLEANUP_MANIFEST = "---\nname: cleanup-test\ndescription: A read-only Skill used by the cleanup tests\n---\nOnly reads files.\n";

test("only rejected Skill records can be removed, and inventory persists the deletion", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-skill-remove-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createSkillStore(dir);
  await store.load();
  const archive = makeZip([{ name: "SKILL.md", data: CLEANUP_MANIFEST }]);
  const digest = await quarantineArchive(dir, archive);
  const record = await store.register({ name: "cleanup-test", archiveSha256: digest });
  await assert.rejects(store.remove(record.id), { statusCode: 409 });
  await store.transition(record.id, { state: "rejected", note: "not wanted" });
  const result = await store.remove(record.id);
  assert.deepEqual(result, { removed: true, archiveRemoved: true });
  await assert.rejects(stat(join(dir, "skill-quarantine", digest + ".zip")), { code: "ENOENT" });
  assert.equal(store.list().total, 0);
  const reloaded = createSkillStore(dir);
  await reloaded.load();
  assert.equal(reloaded.list().total, 0);
  assert.match(await readFile(join(dir, "skills.json"), "utf8"), /\[\]/);
});

test("removing a rejected Skill deletes its unshared quarantined archive only", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-skill-remove-archive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "skill-quarantine"));
  const digest = "cd".repeat(32);
  const archive = join(dir, "skill-quarantine", digest + ".zip");
  await writeFile(archive, "test archive", { mode: 0o600 });
  const store = createSkillStore(dir);
  await store.load();
  const record = await store.register({ name: "rejected-archive", archiveSha256: digest, quarantineFile: "skill-quarantine/" + digest + ".zip" });
  await store.transition(record.id, { state: "rejected" });
  const result = await store.remove(record.id);
  assert.deepEqual(result, { removed: true, archiveRemoved: true });
  await assert.rejects(stat(archive), { code: "ENOENT" });
});

test("shared quarantined archive is retained while another Skill record references its digest", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-skill-shared-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "skill-quarantine"));
  const digest = "ef".repeat(32);
  const archive = join(dir, "skill-quarantine", digest + ".zip");
  await writeFile(archive, "shared archive", { mode: 0o600 });
  const store = createSkillStore(dir);
  await store.load();
  const rejected = await store.register({ name: "rejected-copy", archiveSha256: digest, quarantineFile: "skill-quarantine/" + digest + ".zip" });
  await store.register({ name: "kept-copy", archiveSha256: digest, quarantineFile: "skill-quarantine/" + digest + ".zip" });
  await store.transition(rejected.id, { state: "rejected" });
  const result = await store.remove(rejected.id);
  assert.deepEqual(result, { removed: true, archiveRemoved: false });
  assert.equal((await stat(archive)).isFile(), true);
});

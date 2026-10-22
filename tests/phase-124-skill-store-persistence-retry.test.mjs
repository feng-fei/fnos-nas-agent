import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rename, chmod, unlink, readdir, rm } from "node:fs/promises";
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

const nativeStoreFs = { mkdir, readFile, writeFile, rename, chmod, unlink };

const FIRST_MANIFEST = "---\nname: first-skill\ndescription: A read-only Skill used by the persistence retry tests\n---\nOnly reads files.\n";
const SECOND_MANIFEST = "---\nname: second-skill\ndescription: Another read-only Skill used by the persistence retry tests\n---\nOnly reads files.\n";

function registration(name, digest) {
  return {
    name,
    archiveSha256: digest,
    quarantineFile: `skill-quarantine/${digest}.zip`,
    archiveSizeBytes: 100,
    archiveEntryCount: 1,
    declaredUncompressedBytes: 100
  };
}

test("Skill inventory persistence recovers after a write fails and removes the orphan temp file", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-skill-store-retry-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let failOnce = true;
  const fs = {
    ...nativeStoreFs,
    async writeFile(path, data, options) {
      await writeFile(path, data, options);
      if (failOnce) {
        failOnce = false;
        throw Object.assign(new Error("simulated disk full after temp creation"), { code: "ENOSPC" });
      }
    }
  };
  const store = createSkillStore(dataDir, { fs });

  const firstDigest = await quarantineArchive(dataDir, makeZip([{ name: "SKILL.md", data: FIRST_MANIFEST }]));
  const secondDigest = await quarantineArchive(dataDir, makeZip([{ name: "SKILL.md", data: SECOND_MANIFEST }]));

  await assert.rejects(store.register(registration("First skill", firstDigest)), error =>
    error?.statusCode === 500 && /Unable to save Skill metadata securely/.test(error.message));

  const afterFailure = await readdir(dataDir);
  assert.deepEqual(afterFailure.filter(name => name.endsWith(".tmp")), [], "failed temp file should be removed");
  assert.equal(afterFailure.includes("skills.json"), false, "a failed write must not publish an inventory file");

  const saved = await store.register(registration("Second skill", secondDigest));
  assert.equal(saved.name, "Second skill");
  assert.equal(failOnce, false);

  const inventory = JSON.parse(await readFile(join(dataDir, "skills.json"), "utf8"));
  assert.deepEqual(inventory.map(item => item.name), ["Second skill"]);
  assert.equal((await readdir(dataDir)).some(name => name.endsWith(".tmp")), false);

  const restarted = createSkillStore(dataDir);
  await restarted.load();
  const list = restarted.list();
  assert.equal(list.total, 1);
  assert.equal(list.skills[0].name, "Second skill");
});


test("a failed concurrent registration is not resurrected by the next queued inventory write", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-skill-store-concurrent-retry-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let failOnce = true;
  const fs = {
    ...nativeStoreFs,
    async writeFile(path, data, options) {
      await writeFile(path, data, options);
      if (failOnce) {
        failOnce = false;
        throw Object.assign(new Error("simulated transient write error"), { code: "EIO" });
      }
    }
  };
  const store = createSkillStore(dataDir, { fs });
  const firstDigest = await quarantineArchive(dataDir, makeZip([{ name: "SKILL.md", data: FIRST_MANIFEST }]));
  const secondDigest = await quarantineArchive(dataDir, makeZip([{ name: "SKILL.md", data: SECOND_MANIFEST }]));
  const results = await Promise.allSettled([
    store.register(registration("Rejected first", firstDigest)),
    store.register(registration("Persisted second", secondDigest))
  ]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  const inventory = JSON.parse(await readFile(join(dataDir, "skills.json"), "utf8"));
  assert.deepEqual(inventory.map(item => item.name), ["Persisted second"]);
  assert.equal((await readdir(dataDir)).some(name => name.endsWith(".tmp")), false);
});

test("Skill inventory persistence uses exclusive unique temp files for concurrent registrations", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-skill-store-concurrent-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = createSkillStore(dataDir);
  const firstDigest = await quarantineArchive(dataDir, makeZip([{ name: "SKILL.md", data: FIRST_MANIFEST }]));
  const secondDigest = await quarantineArchive(dataDir, makeZip([{ name: "SKILL.md", data: SECOND_MANIFEST }]));
  const results = await Promise.all([
    store.register(registration("Concurrent A", firstDigest)),
    store.register(registration("Concurrent B", secondDigest))
  ]);
  assert.equal(results.length, 2);
  const restarted = createSkillStore(dataDir);
  await restarted.load();
  assert.deepEqual(restarted.list().skills.map(item => item.name).sort(), ["Concurrent A", "Concurrent B"]);
  assert.equal((await readdir(dataDir)).filter(name => name.endsWith(".tmp")).length, 0);
});

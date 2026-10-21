import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { inspectZipArchive, extractZipEntry, saveQuarantinedArchive, MAX_ARCHIVE_BYTES, MAX_DECLARED_UNCOMPRESSED_BYTES } from "../apps/fnos-nas-agent/app/skill-archives.mjs";
import { createSkillStore } from "../apps/fnos-nas-agent/app/skills.mjs";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(name = "SKILL.md", data = "review me") {
  const nameBytes = Buffer.from(name);
  const dataBytes = Buffer.from(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc32(dataBytes), 14);
  local.writeUInt32LE(dataBytes.length, 18);
  local.writeUInt32LE(dataBytes.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);
  const localPart = Buffer.concat([local, nameBytes, dataBytes]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(crc32(dataBytes), 16);
  central.writeUInt32LE(dataBytes.length, 20);
  central.writeUInt32LE(dataBytes.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  central.writeUInt32LE(0, 42);
  const centralPart = Buffer.concat([central, nameBytes]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localPart, centralPart, eocd]);
}

test("ZIP inspection rejects unsafe paths and accepts a small ordinary archive", () => {
  const good = inspectZipArchive(makeZip());
  assert.equal(good.entryCount, 1);
  assert.equal(good.entries[0].name, "SKILL.md");
  assert.throws(() => inspectZipArchive(makeZip("../outside.txt")), { statusCode: 400 });
  assert.throws(() => inspectZipArchive(makeZip("/absolute.txt")), { statusCode: 400 });
  assert.throws(() => inspectZipArchive(Buffer.from("not a zip")), { statusCode: 400 });
});

test("single-entry extraction verifies exact path, size and CRC without writing files", () => {
  const archive = makeZip("fnos/SKILL.md", "review me");
  assert.deepEqual(extractZipEntry(archive, "fnos/SKILL.md"), Buffer.from("review me"));
  assert.throws(() => extractZipEntry(archive, "fnos/bin/trim-cli"), { statusCode: 404 });
  assert.throws(() => extractZipEntry(archive, "fnos/SKILL.md", 2), { statusCode: 413 });
});

test("quarantine import computes digest from bytes and stores archive privately", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-agent-quarantine-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = makeZip();
  const expected = createHash("sha256").update(archive).digest("hex");
  const result = await saveQuarantinedArchive(dir, archive);
  assert.equal(result.sha256, expected);
  assert.equal(result.entryCount, 1);
  assert.equal((await stat(join(dir, result.quarantineFile))).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(join(dir, result.quarantineFile)), archive);

  const store = createSkillStore(dir);
  await store.load();
  const imported = await store.importArchive({ name: "test-skill", version: "1.0" }, archive);
  assert.equal(imported.archiveSha256, expected);
  assert.equal(imported.state, "pending_review");
  assert.equal(imported.archiveSizeBytes, archive.length);
  assert.equal(imported.quarantineFile, result.quarantineFile);
});

test("archive limits accommodate the supplied official fnOS Skill package", () => {
  assert.ok(MAX_ARCHIVE_BYTES >= 18 * 1024 * 1024);
  assert.ok(MAX_DECLARED_UNCOMPRESSED_BYTES >= 44 * 1024 * 1024);
});

test("archive byte limit is enforced before ZIP parsing", () => {
  assert.throws(() => inspectZipArchive(Buffer.alloc(MAX_ARCHIVE_BYTES + 1)), { statusCode: 413 });
});

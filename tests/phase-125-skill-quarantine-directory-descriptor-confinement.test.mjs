import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, lstat, open, link, unlink, rename, symlink, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { saveQuarantinedArchive } from "../apps/fnos-nas-agent/app/skill-archives.mjs";

const nativeFs = { mkdir, lstat, open, link, unlink };

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entryName, content) {
  const name = Buffer.from(entryName, "utf8");
  const data = Buffer.from(content, "utf8");
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localRecord = Buffer.concat([local, name, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralRecord = Buffer.concat([central, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralRecord.length, 12);
  eocd.writeUInt32LE(localRecord.length, 16);
  return Buffer.concat([localRecord, centralRecord, eocd]);
}

async function fixture({ race = "none" } = {}) {
  const temp = await mkdtemp(join(tmpdir(), "fnos-skill-quarantine-fd-"));
  const dataDir = join(temp, "data");
  const quarantine = join(dataDir, "skill-quarantine");
  const moved = join(dataDir, "skill-quarantine.moved");
  const outside = join(temp, "outside");
  await mkdir(dataDir, { recursive: true });
  await mkdir(outside);
  let armed = race !== "none";
  const fs = {
    ...nativeFs,
    async lstat(path, ...args) {
      const info = await lstat(path, ...args);
      if (race === "before-open" && armed && String(path).includes("/proc/self/fd/") && String(path).endsWith("/skill-quarantine")) {
        armed = false;
        await rename(quarantine, moved);
        await symlink(outside, quarantine);
      }
      return info;
    },
    async open(path, flags, ...args) {
      const handle = await open(path, flags, ...args);
      if (race === "after-open" && armed && String(path).includes("/proc/self/fd/") && String(path).endsWith("/skill-quarantine")) {
        armed = false;
        await rename(quarantine, moved);
        await symlink(outside, quarantine);
      }
      return handle;
    }
  };
  return {
    temp, dataDir, quarantine, moved, outside, fs,
    async cleanup() { await rm(temp, { recursive: true, force: true }); }
  };
}

test("quarantined archives are stored with integrity checks and duplicate imports are idempotent", async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const archive = storedZip("SKILL.md", "---\nname: Safe test\ndescription: Static archive\n---\n");
  const first = await saveQuarantinedArchive(f.dataDir, archive);
  const second = await saveQuarantinedArchive(f.dataDir, archive);
  assert.equal(first.sha256, createHash("sha256").update(archive).digest("hex"));
  assert.deepEqual(second, first);
  const saved = await readFile(join(f.dataDir, first.quarantineFile));
  assert.deepEqual(saved, archive);
  assert.equal((await lstat(join(f.dataDir, first.quarantineFile))).mode & 0o777, 0o600);
});

test("quarantine directory swapped to outside symlink before opening fails closed", async t => {
  const f = await fixture({ race: "before-open" });
  t.after(f.cleanup);
  const archive = storedZip("SKILL.md", "safe");
  await assert.rejects(saveQuarantinedArchive(f.dataDir, archive, { fs: f.fs }), error => error?.statusCode === 409);
  assert.deepEqual(await readdir(f.outside), []);
  assert.deepEqual(await readdir(f.moved), []);
});

test("quarantine path replacement after open never redirects archive bytes outside the descriptor", async t => {
  const f = await fixture({ race: "after-open" });
  t.after(f.cleanup);
  const archive = storedZip("SKILL.md", "safe");
  await assert.rejects(saveQuarantinedArchive(f.dataDir, archive, { fs: f.fs }), error => error?.statusCode === 409);
  assert.deepEqual(await readdir(f.outside), []);
  assert.deepEqual(await readdir(f.moved), []);
});

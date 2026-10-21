import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillStore } from "../apps/fnos-nas-agent/app/skills.mjs";
import { createSkillInstaller } from "../apps/fnos-nas-agent/app/skill-installer.mjs";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const localParts = [], centralParts = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name);
    const data = Buffer.from(item.data);
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
    const localPart = Buffer.concat([local, name, data]);
    localParts.push(localPart);

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
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([central, name]));
    offset += localPart.length;
  }
  const localBytes = Buffer.concat(localParts);
  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, end]);
}

function fakeElf(machine) {
  const data = Buffer.alloc(64);
  data.write("\x7fELF", 0, "binary");
  data[4] = 2;
  data[5] = 1;
  data.writeUInt16LE(machine, 18);
  return data;
}

test("only an approved official Skill can install its matching Linux CLI binary", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-skill-installer-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const binary = fakeElf(62);
  const manifest = JSON.stringify({
    name: "fnos", version: "0.1.1",
    bin: { "linux-x64": "fnos/bin/trim-cli-linux-x64", "linux-arm64": "fnos/bin/trim-cli-linux-arm64" }
  });
  const archive = makeZip([
    { name: "fnos/SKILL.md", data: "---\nname: fnos\ndescription: Official fnOS CLI\n---\n" },
    { name: "fnos/manifest.json", data: manifest },
    { name: "fnos/bin/trim-cli-linux-x64", data: binary }
  ]);
  const store = createSkillStore(dataDir);
  await store.load();
  const imported = await store.importArchive({ name: "fnos", version: "0.1.1" }, archive);
  const installer = createSkillInstaller({ dataDir, platform: "linux", arch: "x64" });

  await assert.rejects(installer.installCli(imported), { statusCode: 409 });
  const approved = await store.transition(imported.id, { state: "approved", note: "Official package reviewed" });
  const result = await installer.installCli(approved);
  assert.equal(result.installed, true);
  assert.equal(result.version, "0.1.1");
  assert.equal(result.platform, "linux-x64");
  assert.equal(result.sizeBytes, binary.length);
  assert.equal(result.binarySha256, createHash("sha256").update(binary).digest("hex"));
  const target = join(dataDir, "skill-tools", imported.id, "trim-cli");
  assert.deepEqual(await readFile(target), binary);
  assert.equal((await stat(target)).mode & 0o777, 0o700);
});

test("CLI installer rejects unsupported platforms and tampered archive metadata", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-skill-installer-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const installer = createSkillInstaller({ dataDir, platform: "win32", arch: "x64" });
  await assert.rejects(installer.installCli({ id: "a".repeat(24), state: "approved", name: "fnos", manifestReview: { name: "fnos" }, archiveSha256: "b".repeat(64), quarantineFile: "skill-quarantine/" + "b".repeat(64) + ".zip" }), { statusCode: 400 });
});

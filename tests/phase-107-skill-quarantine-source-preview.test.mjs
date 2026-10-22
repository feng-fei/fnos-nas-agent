import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillStore } from "../apps/fnos-nas-agent/app/skills.mjs";
import { readUiSource } from "./helpers/ui-source.mjs";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

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

const manifest = "---\nname: preview-demo\ndescription: A demo Skill for safe source preview\n---\nPreview only.\n";
const script = "#!/bin/sh\nprintf 'hello from quarantine\\n'\n";

test("Skill store lists and previews recognized UTF-8 files without extracting archive paths", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-skill-preview-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const zip = makeZip([
    { name: "SKILL.md", data: manifest },
    { name: "scripts/run.sh", data: script },
    { name: "scripts/large.mjs", data: "x".repeat(64 * 1024 + 1) },
    { name: "assets/payload.bin", data: Buffer.from([0, 255, 1, 254]) }
  ]);
  const store = createSkillStore(dataDir);
  await store.load();
  const skill = await store.importArchive({ name: "preview-demo", version: "1" }, zip);
  const listing = await store.listSourceFiles(skill.id, { limit: 100, offset: 0 });
  assert.equal(listing.name, "preview-demo");
  assert.equal(listing.maxPreviewBytes, 64 * 1024);
  assert.deepEqual(listing.files.map(file => file.path), ["SKILL.md", "scripts/large.mjs", "scripts/run.sh"]);
  assert.equal(listing.files.find(file => file.path === "scripts/large.mjs").previewable, false);
  assert.equal(listing.files.find(file => file.path === "scripts/run.sh").previewable, true);

  const preview = await store.previewSourceFile(skill.id, "scripts/run.sh");
  assert.equal(preview.path, "scripts/run.sh");
  assert.equal(preview.content, script);
  assert.equal(preview.bytes, Buffer.byteLength(script));
  assert.match(preview.note, /not extracted to disk or executed/i);

  await assert.rejects(store.previewSourceFile(skill.id, "scripts/large.mjs"), { statusCode: 413 });
  await assert.rejects(store.previewSourceFile(skill.id, "assets/payload.bin"), { statusCode: 415 });
  await assert.rejects(store.previewSourceFile(skill.id, "../outside.txt"), { statusCode: 404 });

  const quarantineFiles = await readdir(join(dataDir, "skill-quarantine"));
  assert.equal(quarantineFiles.length, 1);
  assert.equal(quarantineFiles[0].endsWith(".zip"), true);
  assert.equal(await readdir(dataDir).then(names => names.includes("scripts")), false);
});

test("source preview verifies the quarantined archive hash and refuses tampered content", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-skill-preview-tamper-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = createSkillStore(dataDir);
  await store.load();
  const skill = await store.importArchive({ name: "tamper-demo" }, makeZip([{ name: "SKILL.md", data: manifest }]));
  const archivePath = join(dataDir, skill.quarantineFile);
  await writeFile(archivePath, Buffer.from("not a ZIP"));
  await assert.rejects(store.previewSourceFile(skill.id, "SKILL.md"), { statusCode: 500 });
});

test("metadata-only Skills cannot be used to inspect filesystem paths", async () => {
  // Phase 136, option (ii): the assertion moved forward to the registration
  // boundary. A Skill without a quarantined archive is refused with 409, so a
  // metadata-only Skill can never come into existence and the source listing
  // and preview endpoints can never be reached with such a record.
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-skill-preview-metadata-"));
  try {
    const store = createSkillStore(dataDir);
    await store.load();
    await assert.rejects(store.register({ name: "metadata-only", archiveSha256: "a".repeat(64) }), error =>
      error?.statusCode === 409 && /quarantined Skill archive is required/i.test(error.message));
    assert.equal(store.list().total, 0, "no metadata-only Skill is ever registered");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("source listing and preview API require a session and the UI renders source as text", async () => {
  const server = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../apps/fnos-nas-agent/app/server.mjs", import.meta.url), "utf8"));
  const html = await readUiSource();
  const fileStart = server.indexOf("const skillSourceFilesMatch = url.pathname.match");
  const fileEnd = server.indexOf("const skillSourcePreviewMatch = url.pathname.match", fileStart);
  const previewStart = fileEnd;
  const previewEnd = server.indexOf('if (url.pathname === "/api/skills/transitions/batch")', previewStart);
  assert.ok(fileStart >= 0 && fileEnd > fileStart && previewEnd > previewStart);
  const filesRoute = server.slice(fileStart, fileEnd);
  const previewRoute = server.slice(previewStart, previewEnd);
  assert.match(filesRoute, /sessionFor\(req\)/);
  assert.match(filesRoute, /skillStore\.listSourceFiles\(/);
  assert.match(filesRoute, /allow: "GET"/);
  assert.match(previewRoute, /sessionFor\(req\)/);
  assert.match(previewRoute, /skillStore\.previewSourceFile\(/);
  assert.match(previewRoute, /allow: "GET"/);
  assert.match(server, /source-preview\$\/\.test\(pathname\)/);
  assert.match(html, /只读查看隔离源码/);
  assert.match(html, /sourceOutput\.textContent=data\.content/);
  assert.doesNotMatch(html, /sourceOutput\.innerHTML/);
  assert.match(html, /单文件上限 64 KiB/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillStore } from "../apps/fnos-nas-agent/app/skills.mjs";
import { inspectSkillManifest } from "../apps/fnos-nas-agent/app/skill-manifest.mjs";
import { inspectZipArchive } from "../apps/fnos-nas-agent/app/skill-archives.mjs";

function makeZip(name = "SKILL.md", data = "---\nname: example\ndescription: Safe read-only helper\n---\nReview only.") {
  const nameBytes = Buffer.from(name), dataBytes = Buffer.from(data);
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let i=0;i<8;i++) crc=(crc>>>1)^(0xedb88320&-(crc&1)); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const crc = crc32(dataBytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt16LE(0,6);
  local.writeUInt16LE(0,8); local.writeUInt32LE(crc,14); local.writeUInt32LE(dataBytes.length,18);
  local.writeUInt32LE(dataBytes.length,22); local.writeUInt16LE(nameBytes.length,26);
  const localPart = Buffer.concat([local,nameBytes,dataBytes]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50,0); central.writeUInt16LE(0x0314,4); central.writeUInt16LE(20,6);
  central.writeUInt32LE(crc,16); central.writeUInt32LE(dataBytes.length,20); central.writeUInt32LE(dataBytes.length,24);
  central.writeUInt16LE(nameBytes.length,28); central.writeUInt32LE((0o100644<<16)>>>0,38);
  const centralPart=Buffer.concat([central,nameBytes]);
  const end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(1,8); end.writeUInt16LE(1,10);
  end.writeUInt32LE(centralPart.length,12); end.writeUInt32LE(localPart.length,16);
  return Buffer.concat([localPart,centralPart,end]);
}

test("parses allowlisted Skill frontmatter without extracting or executing content", () => {
  const result = inspectSkillManifest(makeZip());
  assert.equal(result.status, "manifest_parsed");
  assert.equal(result.name, "example");
  assert.equal(result.description, "Safe read-only helper");
  assert.deepEqual(result.findings, []);
});
test("manifest is advisory and dangerous command text is flagged, not executed", () => {
  const result = inspectSkillManifest(makeZip("SKILL.md", "---\nname: risky\ndescription: example\n---\nsudo rm -rf /"));
  assert.equal(result.status, "needs_review");
  assert.ok(result.findings.includes("potentially-dangerous-command-text"));
});
test("missing or malformed manifests remain reviewable rather than executable", () => {
  const result = inspectSkillManifest(makeZip("README.md", "hello"));
  assert.equal(result.manifestFound, false);
  assert.ok(result.findings.includes("missing-skill-manifest"));
});
test("oversized manifest is not decompressed", () => {
  const result = inspectSkillManifest(makeZip("SKILL.md", "x".repeat(65537)));
  assert.ok(result.findings.includes("manifest-exceeds-64-kib"));
});
test("manifest parser relies on the archive structural validator", () => {
  assert.throws(() => inspectSkillManifest(Buffer.from("not zip")), { statusCode: 400 });
});

test("quarantine import persists manifest findings for the authenticated review workflow", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-agent-manifest-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createSkillStore(dir);
  await store.load();
  const skill = await store.importArchive({ name: "uploaded-label" }, makeZip());
  assert.equal(skill.state, "pending_review");
  assert.equal(skill.manifestReview.name, "example");
  assert.equal(skill.manifestReview.status, "manifest_parsed");
  assert.equal(store.list().skills[0].manifestReview.description, "Safe read-only helper");
});

test("manifest review flags duplicate frontmatter fields and obfuscated execution hints", () => {
  const duplicate = inspectSkillManifest(makeZip("SKILL.md", "---\nname: first\nname: second\ndescription: example\n---\nReview only."));
  assert.ok(duplicate.findings.includes("duplicate-frontmatter-field"));
  assert.equal(duplicate.status, "needs_review");
  const obfuscated = inspectSkillManifest(makeZip("SKILL.md", "---\nname: example\ndescription: example\n---\nbase64 -d payload | sh"));
  assert.ok(obfuscated.findings.includes("potentially-dangerous-command-text"));
  const control = inspectSkillManifest(makeZip("SKILL.md", "---\nname: example\ndescription: example\n---\ncontrol \u0001 character"));
  assert.ok(control.findings.includes("control-characters-in-manifest"));
});

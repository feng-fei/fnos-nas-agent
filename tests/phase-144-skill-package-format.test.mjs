import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import {
  parseSkillPackage,
  SKILL_PACKAGE_DIRECTORIES,
  MAX_PACKAGE_BYTES
} from "../apps/fnos-nas-agent/app/skill-package.mjs";
import { makeZip } from "./helpers/skill-archive.mjs";

/**
 * Phase 144 — Skill package format parser.
 *
 * The fixtures below are built in memory. Nothing is written to disk and no
 * imported content is ever executed by the parser.
 *
 * `makeZip` from the shared helper covers the ordinary archives. The two
 * hostile fixtures (a symbolic link entry and a duplicated path) need the
 * central directory to carry extra attributes, so they use a local builder.
 */

/** Builds a stored-mode ZIP archive; `mode` allows fixture symlink entries. */
function makeArchiveWithModes(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  let centralSize = 0;
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
    central.writeUInt32LE((((entry.mode ?? 0o100644) << 16) >>> 0), 38);
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

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const MANIFEST_TEXT = [
  "---",
  "name: sample-skill",
  "description: A packaged Skill used by the Phase 144 format tests",
  "---",
  "",
  "Only reads files.",
  ""
].join("\n");

const METADATA_TEXT = JSON.stringify({
  name: "sample-skill",
  description: "A packaged Skill used by the Phase 144 format tests",
  version: "1.2.3",
  agentApiRange: ">=0.2.0 <0.4.0",
  capabilities: ["files.read", "documents.search"],
  license: "MIT"
});

const REFERENCE_TEXT = "reference body\n";
const SCRIPT_TEXT = "#!/bin/sh\necho hello\n";
const TEST_TEXT = "assert true\n";

function fullPackage() {
  return makeZip([
    { name: "SKILL.md", data: MANIFEST_TEXT },
    { name: "metadata.json", data: METADATA_TEXT },
    { name: "references/overview.md", data: REFERENCE_TEXT },
    { name: "references/deep/detail.md", data: REFERENCE_TEXT },
    { name: "scripts/check.sh", data: SCRIPT_TEXT },
    { name: "tests/check.test.sh", data: TEST_TEXT }
  ]);
}

const digest = text => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const rules = result => result.findings.map(finding => finding.rule);

test("parses a complete Skill package", () => {
  const result = parseSkillPackage(fullPackage());
  assert.equal(result.status, "ok");
  assert.deepEqual(result.findings, []);
  assert.equal(result.manifest.name, "sample-skill");
  assert.equal(result.manifest.description, "A packaged Skill used by the Phase 144 format tests");
  assert.equal(result.manifest.version, "1.2.3");
  assert.equal(result.manifest.agentApiRange, ">=0.2.0 <0.4.0");
  assert.deepEqual(result.manifest.capabilities, ["files.read", "documents.search"]);
  assert.equal(result.manifest.license, "MIT");
  assert.equal(result.instructions, "Only reads files.\n");
  assert.deepEqual(result.references.map(item => item.path), ["references/overview.md", "references/deep/detail.md"]);
  assert.deepEqual(result.scripts.map(item => item.path), ["scripts/check.sh"]);
  assert.deepEqual(result.tests.map(item => item.path), ["tests/check.test.sh"]);
  assert.deepEqual(result.inventory.map(item => item.path), [
    "SKILL.md",
    "metadata.json",
    "references/overview.md",
    "references/deep/detail.md",
    "scripts/check.sh",
    "tests/check.test.sh"
  ]);
});

test("hashes every package file with SHA-256", () => {
  const result = parseSkillPackage(fullPackage());
  const byPath = new Map(result.inventory.map(item => [item.path, item]));
  assert.equal(byPath.get("references/overview.md").sha256, digest(REFERENCE_TEXT));
  assert.equal(byPath.get("references/deep/detail.md").sha256, digest(REFERENCE_TEXT));
  assert.equal(byPath.get("scripts/check.sh").sha256, digest(SCRIPT_TEXT));
  assert.equal(byPath.get("SKILL.md").sha256, digest(MANIFEST_TEXT));
  assert.equal(byPath.get("SKILL.md").bytes, Buffer.byteLength(MANIFEST_TEXT, "utf8"));
});

test("reports a package without a SKILL.md manifest", () => {
  const result = parseSkillPackage(makeZip([
    { name: "metadata.json", data: METADATA_TEXT },
    { name: "references/overview.md", data: REFERENCE_TEXT }
  ]));
  assert.equal(result.status, "invalid");
  assert.ok(rules(result).includes("missing-skill-manifest"));
  assert.equal(result.manifest.name, null);
  assert.deepEqual(result.references, []);
});

test("reports more than one SKILL.md manifest", () => {
  const result = parseSkillPackage(makeZip([
    { name: "SKILL.md", data: MANIFEST_TEXT },
    { name: "nested/SKILL.md", data: MANIFEST_TEXT }
  ]));
  assert.equal(result.status, "invalid");
  assert.ok(rules(result).includes("multiple-skill-manifests"));
});

test("rejects path traversal entries", () => {
  const result = parseSkillPackage(makeZip([
    { name: "SKILL.md", data: MANIFEST_TEXT },
    { name: "../escape.md", data: "nope" }
  ]));
  assert.equal(result.status, "invalid");
  assert.ok(rules(result).includes("entry-path-traversal"));
  assert.equal(result.instructions, "");
});

test("rejects absolute and backslash entry paths", () => {
  const absolute = parseSkillPackage(makeZip([
    { name: "SKILL.md", data: MANIFEST_TEXT },
    { name: "/etc/passwd", data: "nope" }
  ]));
  assert.equal(absolute.status, "invalid");
  assert.ok(rules(absolute).includes("entry-absolute-path"));

  const backslash = parseSkillPackage(makeZip([
    { name: "SKILL.md", data: MANIFEST_TEXT },
    { name: "references\\overview.md", data: "nope" }
  ]));
  assert.equal(backslash.status, "invalid");
  assert.ok(rules(backslash).includes("entry-backslash-path"));
});

test("rejects symbolic link entries", () => {
  const result = parseSkillPackage(makeArchiveWithModes([
    { name: "SKILL.md", data: MANIFEST_TEXT },
    { name: "references/link.md", data: "/etc/passwd", mode: 0o120777 }
  ]));
  assert.equal(result.status, "invalid");
  assert.ok(rules(result).includes("entry-symbolic-link"));
  assert.deepEqual(result.references, []);
});

test("rejects directories outside the package format", () => {
  const result = parseSkillPackage(makeZip([
    { name: "SKILL.md", data: MANIFEST_TEXT },
    { name: "assets/logo.png", data: "binary" }
  ]));
  assert.equal(result.status, "invalid");
  assert.ok(rules(result).includes("unsupported-package-directory"));
  assert.deepEqual(result.inventory.map(item => item.path), []);
});

test("ignores root files that are not part of the package format", () => {
  const result = parseSkillPackage(makeZip([
    { name: "SKILL.md", data: MANIFEST_TEXT },
    { name: "metadata.json", data: METADATA_TEXT },
    { name: "README.md", data: "# readme\n" }
  ]));
  assert.equal(result.status, "incomplete");
  assert.ok(rules(result).includes("unsupported-package-file"));
  assert.deepEqual(result.inventory.map(item => item.path), ["SKILL.md", "metadata.json"]);
});

test("ignores entries that lie outside the package root", () => {
  const result = parseSkillPackage(makeZip([
    { name: "pkg/SKILL.md", data: MANIFEST_TEXT },
    { name: "pkg/metadata.json", data: METADATA_TEXT },
    { name: "other/notes.md", data: "outside\n" }
  ]));
  assert.equal(result.status, "incomplete");
  assert.ok(rules(result).includes("entry-outside-package-root"));
  assert.deepEqual(result.inventory.map(item => item.path), ["pkg/SKILL.md", "pkg/metadata.json"]);
  assert.equal(result.manifest.name, "sample-skill");
});

test("exposes the supported package directories", () => {
  assert.deepEqual([...SKILL_PACKAGE_DIRECTORIES], ["references", "scripts", "tests"]);
});

test("reports malformed metadata.json", () => {
  const result = parseSkillPackage(makeZip([
    { name: "SKILL.md", data: MANIFEST_TEXT },
    { name: "metadata.json", data: "{not json" }
  ]));
  assert.equal(result.status, "invalid");
  assert.ok(rules(result).includes("invalid-metadata-json"));
});

test("reports invalid metadata field values", () => {
  const result = parseSkillPackage(makeZip([
    { name: "SKILL.md", data: MANIFEST_TEXT },
    { name: "metadata.json", data: JSON.stringify({ version: "one", agentApiRange: "not a range", capabilities: ["bad capability!"] }) }
  ]));
  assert.equal(result.status, "invalid");
  assert.ok(rules(result).includes("invalid-metadata-version"));
  assert.ok(rules(result).includes("invalid-metadata-agent-api-range"));
  assert.ok(rules(result).includes("invalid-metadata-capabilities"));
});

test("reports a manifest without frontmatter", () => {
  const result = parseSkillPackage(makeZip([
    { name: "SKILL.md", data: "no frontmatter here" }
  ]));
  assert.equal(result.status, "invalid");
  assert.ok(rules(result).includes("manifest-missing-frontmatter"));
  assert.ok(rules(result).includes("missing-name-field"));
  assert.ok(rules(result).includes("missing-description-field"));
});

test("enforces the archive size limit", () => {
  const result = parseSkillPackage(fullPackage(), { limits: { maxPackageBytes: 32 } });
  assert.equal(result.status, "invalid");
  assert.ok(rules(result).includes("package-too-large"));
});

test("enforces the entry count limit", () => {
  const result = parseSkillPackage(fullPackage(), { limits: { maxEntries: 2 } });
  assert.equal(result.status, "invalid");
  assert.ok(rules(result).includes("package-too-many-entries"));
});

test("enforces the per-file size limit for package files", () => {
  const result = parseSkillPackage(fullPackage(), { limits: { maxReferenceFileBytes: 4 } });
  assert.equal(result.status, "invalid");
  assert.ok(rules(result).includes("reference-file-too-large"));
  assert.deepEqual(result.references, []);
});

test("enforces the per-directory file count limit", () => {
  const result = parseSkillPackage(fullPackage(), { limits: { maxReferences: 1 } });
  assert.equal(result.status, "invalid");
  assert.ok(rules(result).includes("too-many-reference-files"));
});

test("keeps reference hashes stable across repeated parses", () => {
  const archive = fullPackage();
  const first = parseSkillPackage(archive);
  const second = parseSkillPackage(archive);
  assert.deepEqual(first.references, second.references);
  assert.deepEqual(first.inventory, second.inventory);
  assert.equal(first.references[0].sha256, second.references[0].sha256);
  assert.equal(first.references[0].sha256, digest(REFERENCE_TEXT));
});

test("is idempotent for the same archive bytes", () => {
  const archive = fullPackage();
  const first = parseSkillPackage(archive);
  const second = parseSkillPackage(archive);
  assert.deepEqual(first.manifest, second.manifest);
  assert.deepEqual(first.instructions, second.instructions);
  assert.deepEqual(first.findings, second.findings);
  assert.equal(first.status, second.status);
});

test("marks a package without optional sections as incomplete", () => {
  const result = parseSkillPackage(makeZip([
    { name: "SKILL.md", data: MANIFEST_TEXT }
  ]));
  assert.equal(result.status, "incomplete");
  assert.ok(rules(result).includes("missing-metadata-json"));
  assert.ok(rules(result).includes("missing-references-directory"));
  assert.ok(rules(result).includes("missing-scripts-directory"));
  assert.ok(rules(result).includes("missing-tests-directory"));
  assert.equal(result.manifest.name, "sample-skill");
  assert.equal(result.manifest.version, null);
});

test("rejects input that is not a ZIP archive", () => {
  const result = parseSkillPackage(Buffer.from("not a zip file", "utf8"));
  assert.equal(result.status, "invalid");
  assert.ok(rules(result).includes("package-not-a-zip"));
});

test("keeps the default archive limit at 25 MiB", () => {
  assert.equal(MAX_PACKAGE_BYTES, 25 * 1024 * 1024);
});

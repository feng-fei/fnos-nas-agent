import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillStore, reviewSkillPackageBuffer } from "../apps/fnos-nas-agent/app/skills.mjs";
import { makeZip, READ_ONLY_MANIFEST } from "./helpers/skill-archive.mjs";

/**
 * Phase 187 — the Skill archive structure is reviewed on import.
 *
 * The verdict is computed by the server from the quarantined bytes, stored on
 * the record and shown in the Skill page. A structurally incomplete package is
 * never stored as "ok"; a parser failure is stored as null, never as a pass.
 *
 * The quarantine storage itself is POSIX-only (secure directory descriptors),
 * so the import pipeline is exercised on Linux and the review contract is
 * tested here through the same exported function the importer calls.
 */

async function makeStore(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-skill-package-review-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = createSkillStore(dataDir);
  await store.load();
  return { dataDir, store };
}

const METADATA = JSON.stringify({
  name: "sample-skill",
  version: "1.0.0",
  description: "A minimal read-only Skill used by the integration tests"
});

test("a complete package is reported with its references, scripts and tests", () => {
  const archive = makeZip([
    { name: "SKILL.md", data: READ_ONLY_MANIFEST },
    { name: "metadata.json", data: METADATA },
    { name: "references/nas-builtin-tools.md", data: "# Built-in tools\n" },
    { name: "scripts/verify.mjs", data: "console.log('read only');\n" },
    { name: "tests/smoke.sh", data: "#!/bin/sh\ntrue\n" }
  ]);
  const review = reviewSkillPackageBuffer(archive);
  assert.equal(review.status, "ok");
  assert.equal(review.references, 1);
  assert.equal(review.scripts, 1);
  assert.equal(review.tests, 1);
  assert.equal(review.reviewedBy, "server");
  assert.deepEqual(review.findings, []);
});

test("a package with only warnings is reported as incomplete, not ok", () => {
  const archive = makeZip([
    { name: "SKILL.md", data: READ_ONLY_MANIFEST },
    { name: "references/one.md", data: "# one\n" }
  ]);
  const review = reviewSkillPackageBuffer(archive);
  assert.equal(review.status, "incomplete");
  assert.equal(review.references, 1);
  assert.ok(review.findings.some(item => item.rule === "missing-metadata-json" && item.severity === "warning"));
});

test("a package without SKILL.md is reported as invalid, never as ok", () => {
  const archive = makeZip([{ name: "scripts/run.sh", data: "#!/bin/sh\ntrue\n" }]);
  const review = reviewSkillPackageBuffer(archive);
  assert.equal(review.status, "invalid");
  assert.ok(review.findings.some(item => item.rule === "missing-skill-manifest"));
  assert.ok(review.findings.every(item => item.severity === "error" || item.severity === "warning"));
  assert.equal(review.reviewedBy, "server");
});

test("bytes that are not an archive are reported as invalid, never as ok", () => {
  const review = reviewSkillPackageBuffer(Buffer.from("not a zip at all", "utf8"));
  assert.equal(review.status, "invalid");
  assert.ok(review.findings.some(item => item.rule === "package-not-a-zip" && item.severity === "error"));
});

test("the importer stores the review on the record it persists", async () => {
  const source = await readFile(join(process.cwd(), "apps/fnos-nas-agent/app/skills.mjs"), "utf8");
  const register = source.slice(source.indexOf("async function register("));
  const body = register.slice(0, register.indexOf("\n  async function ") + 1);
  assert.match(body, /reviewSkillPackageBuffer\(quarantined\.buffer\)/, "the importer must review the quarantined bytes");
  assert.match(body, /packageReview:/, "the review must be stored on the record");
  assert.match(source, /packageReview: normalizePackageReview\(item\.packageReview\)/, "a reloaded review must be normalized");
});

test("a stored review is normalized instead of trusted, and survives a reload", async t => {
  const { dataDir } = await makeStore(t);
  const archiveSha256 = "a".repeat(64);
  const record = {
    id: "0123456789abcdef01234567",
    name: "hand-edited",
    version: "1",
    sourceLabel: "manual",
    importedAt: "2026-10-22T00:00:00.000Z",
    archiveSha256,
    state: "pending_review",
    quarantineFile: "skill-quarantine/" + archiveSha256 + ".zip",
    manifestReview: null,
    packageReview: { status: "definitely_fine", references: -5, scripts: "many", tests: 2, findings: [{ rule: "ok" }], reviewedBy: "me" },
    reviewNote: "",
    reviewedAt: null
  };
  await writeFile(join(dataDir, "skills.json"), JSON.stringify([record]), "utf8");

  const store = createSkillStore(dataDir);
  await store.load();
  const saved = store.list().skills[0];
  assert.equal(saved.packageReview.status, "invalid");
  assert.equal(saved.packageReview.references, 0);
  assert.equal(saved.packageReview.scripts, 0);
  assert.equal(saved.packageReview.tests, 2);
  assert.deepEqual(saved.packageReview.findings, [{ rule: "ok", severity: "warning" }]);
  assert.equal(saved.packageReview.reviewedBy, null, "a hand-edited review can never claim the server reviewed it");
});

test("the Skill page renders the package verdict next to the manifest verdict", async () => {
  const pages = await readFile(join(process.cwd(), "apps/fnos-nas-agent/app/ui/pages.js"), "utf8");
  assert.match(pages, /item\.packageReview/);
  assert.match(pages, /包结构：/);
  assert.match(pages, /createElement\("p"\)/);
  assert.doesNotMatch(pages, /packageReview[^\n]*innerHTML/);
});

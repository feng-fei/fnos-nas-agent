import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isOfficialFnosPackage } from "../apps/fnos-nas-agent/app/skill-official-package.mjs";

const appDir = new URL("../apps/fnos-nas-agent/app/", import.meta.url);
const read = async name => readFile(new URL(name, appDir), "utf8");

const digest = "a".repeat(64);
const officialRecord = overrides => ({
  id: "42648edaf303bc9e9564b092",
  name: "fnos-skill",
  state: "enabled",
  archiveSha256: digest,
  quarantineFile: `skill-quarantine/${digest}.zip`,
  manifestReview: {
    reviewedBy: "server",
    name: "fnos",
    archiveSha256: digest,
    status: "needs_review"
  },
  ...overrides
});

test("the official package identity is decided by the server side review, not by the typed name", () => {
  assert.equal(isOfficialFnosPackage(officialRecord()), true);
  assert.equal(isOfficialFnosPackage(officialRecord({ name: "fnos" })), true);
  assert.equal(isOfficialFnosPackage(officialRecord({ name: "FNOS" })), true);
  assert.equal(isOfficialFnosPackage(officialRecord({ name: "fnos-skiil" })), true);
  assert.equal(isOfficialFnosPackage(officialRecord({ name: "我的 fnOS 技能" })), true);
  assert.equal(isOfficialFnosPackage(officialRecord({ name: "" })), true);
});

test("a record the server never reviewed is not an official package", () => {
  assert.equal(isOfficialFnosPackage(officialRecord({ manifestReview: { ...officialRecord().manifestReview, reviewedBy: "client" } })), false);
  assert.equal(isOfficialFnosPackage(officialRecord({ manifestReview: { ...officialRecord().manifestReview, reviewedBy: undefined } })), false);
  assert.equal(isOfficialFnosPackage(officialRecord({ manifestReview: null })), false);
  assert.equal(isOfficialFnosPackage(officialRecord({ manifestReview: undefined })), false);
});

test("the review must describe the very archive the record points at", () => {
  const other = "b".repeat(64);
  assert.equal(isOfficialFnosPackage(officialRecord({ manifestReview: { ...officialRecord().manifestReview, archiveSha256: other } })), false);
  assert.equal(isOfficialFnosPackage(officialRecord({ archiveSha256: other })), false);
  assert.equal(isOfficialFnosPackage(officialRecord({ quarantineFile: "skill-quarantine/other.zip" })), false);
  assert.equal(isOfficialFnosPackage(officialRecord({ archiveSha256: "not-a-digest" })), false);
});

test("only the official manifest name qualifies", () => {
  assert.equal(isOfficialFnosPackage(officialRecord({ manifestReview: { ...officialRecord().manifestReview, name: "trim-cli" } })), false);
  assert.equal(isOfficialFnosPackage(officialRecord({ manifestReview: { ...officialRecord().manifestReview, name: undefined } })), false);
  assert.equal(isOfficialFnosPackage(null), false);
  assert.equal(isOfficialFnosPackage(undefined), false);
  assert.equal(isOfficialFnosPackage("fnos"), false);
});

test("the installer and the server share the same rule and no longer read the typed name", async () => {
  const installer = await read("skill-installer.mjs");
  const server = await read("server.mjs");
  assert.match(installer, /import \{ isOfficialFnosPackage \} from "\.\/skill-official-package\.mjs";/);
  assert.match(installer, /if \(!isOfficialFnosPackage\(record\)\)/);
  assert.doesNotMatch(installer, /record\.name\.toLowerCase\(\) !== "fnos"/);
  assert.match(server, /import \{ isOfficialFnosPackage \} from "\.\/skill-official-package\.mjs";/);
  assert.match(server, /enabled\.find\(item => isOfficialFnosPackage\(item\)\)/);
  assert.doesNotMatch(server, /item\.name\.toLowerCase\(\) === "fnos"/);
});

test("the console applies the same rule so the install button appears for a renamed official package", async () => {
  const pages = await read("ui/pages.js");
  assert.match(pages, /const officialPackage=item\.manifestReview\?\.reviewedBy==="server"/);
  assert.doesNotMatch(pages, /item\.name\?\.toLowerCase\(\)==="fnos"/);
});

test("an install refusal keeps its own status code instead of collapsing into a server error", async () => {
  const server = await read("server.mjs");
  assert.match(server, /const status = \[400, 403, 404, 409, 413\]\.includes\(error\?\.statusCode\)/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillStore } from "../apps/fnos-nas-agent/app/skills.mjs";

test("Skill metadata persists and lifecycle transitions fail closed", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-agent-skills-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createSkillStore(dir);
  await store.load();

  const digest = "0123456789abcdef".repeat(4);
  const record = await store.register({
    name: "sample-skill",
    version: "1.2.3",
    sourceLabel: "manual metadata",
    archiveSha256: digest,
    declaredCapabilities: ["read-only"]
  });
  assert.equal(record.state, "pending_review");
  assert.match(record.id, /^[a-f0-9]{24}$/);
  assert.equal((await stat(join(dir, "skills.json"))).mode & 0o777, 0o600);
  assert.equal(store.list().total, 1);

  await assert.rejects(store.transition(record.id, { state: "enabled" }), { statusCode: 409 });
  await store.transition(record.id, { state: "approved", note: "reviewed" });
  await store.transition(record.id, { state: "enabled" });
  await store.transition(record.id, { state: "disabled" });
  await store.transition(record.id, { state: "approved" });
  await store.transition(record.id, { state: "rejected" });
  await assert.rejects(store.transition(record.id, { state: "approved" }), { statusCode: 409 });

  const reloaded = createSkillStore(dir);
  await reloaded.load();
  const persisted = reloaded.list().skills[0];
  assert.equal(persisted.state, "rejected");
  assert.equal(persisted.archiveSha256, digest);
  assert.equal(persisted.reviewNote, "");
  const raw = await readFile(join(dir, "skills.json"), "utf8");
  assert.equal(raw.includes("payload"), false);
});

test("Skill registration validates digest and bounds metadata", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-agent-skills-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createSkillStore(dir);
  await store.load();
  await assert.rejects(store.register({ name: "../bad", archiveSha256: "not-a-hash" }), { statusCode: 400 });
  await assert.rejects(store.register({ name: "", archiveSha256: "a".repeat(64) }), { statusCode: 400 });
  const item = await store.register({ name: "ok", archiveSha256: "A".repeat(64), declaredCapabilities: ["x".repeat(200)] });
  assert.equal(item.archiveSha256, "a".repeat(64));
  assert.equal(item.declaredCapabilities[0].length, 80);
});

test("Skill inventory search matches metadata and capabilities before applying pagination", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-agent-skills-search-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createSkillStore(dir);
  await store.load();
  const first = await store.register({
    name: "Official fnOS",
    version: "2.0.0",
    sourceLabel: "official package",
    archiveSha256: "a".repeat(64),
    declaredCapabilities: ["read-only", "system diagnostics"],
    manifestReview: { name: "fnos", description: "Manage NAS files" }
  });
  await store.register({
    name: "Photo Helper",
    version: "1.1.0",
    sourceLabel: "community",
    archiveSha256: "b".repeat(64),
    declaredCapabilities: ["image metadata"]
  });
  assert.equal(store.list({ q: "OFFICIAL" }).total, 1);
  assert.equal(store.list({ q: "diagnostics" }).skills[0].id, first.id);
  assert.equal(store.list({ q: "manage nas files" }).total, 1);
  assert.equal(store.list({ q: "official", state: "enabled" }).total, 0);
  assert.equal(store.list({ q: "community" }).total, 1);
  assert.equal(store.list({ q: "a", limit: 1, offset: 1 }).skills.length, 1);
  assert.equal(store.list({ q: "x".repeat(101) }).total, 0);
});

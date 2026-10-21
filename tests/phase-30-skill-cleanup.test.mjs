import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillStore } from "../apps/fnos-nas-agent/app/skills.mjs";

test("only rejected Skill records can be removed, and inventory persists the deletion", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-skill-remove-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createSkillStore(dir);
  await store.load();
  const record = await store.register({ name: "cleanup-test", archiveSha256: "ab".repeat(32) });
  await assert.rejects(store.remove(record.id), { statusCode: 409 });
  await store.transition(record.id, { state: "rejected", note: "not wanted" });
  const result = await store.remove(record.id);
  assert.deepEqual(result, { removed: true, archiveRemoved: false });
  assert.equal(store.list().total, 0);
  const reloaded = createSkillStore(dir);
  await reloaded.load();
  assert.equal(reloaded.list().total, 0);
  assert.match(await readFile(join(dir, "skills.json"), "utf8"), /\[\]/);
});

test("removing a rejected Skill deletes its unshared quarantined archive only", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-skill-remove-archive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "skill-quarantine"));
  const digest = "cd".repeat(32);
  const archive = join(dir, "skill-quarantine", digest + ".zip");
  await writeFile(archive, "test archive", { mode: 0o600 });
  const store = createSkillStore(dir);
  await store.load();
  const record = await store.register({ name: "rejected-archive", archiveSha256: digest, quarantineFile: "skill-quarantine/" + digest + ".zip" });
  await store.transition(record.id, { state: "rejected" });
  const result = await store.remove(record.id);
  assert.deepEqual(result, { removed: true, archiveRemoved: true });
  await assert.rejects(stat(archive), { code: "ENOENT" });
});

test("shared quarantined archive is retained while another Skill record references its digest", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-skill-shared-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "skill-quarantine"));
  const digest = "ef".repeat(32);
  const archive = join(dir, "skill-quarantine", digest + ".zip");
  await writeFile(archive, "shared archive", { mode: 0o600 });
  const store = createSkillStore(dir);
  await store.load();
  const rejected = await store.register({ name: "rejected-copy", archiveSha256: digest, quarantineFile: "skill-quarantine/" + digest + ".zip" });
  await store.register({ name: "kept-copy", archiveSha256: digest, quarantineFile: "skill-quarantine/" + digest + ".zip" });
  await store.transition(rejected.id, { state: "rejected" });
  const result = await store.remove(rejected.id);
  assert.deepEqual(result, { removed: true, archiveRemoved: false });
  assert.equal((await stat(archive)).isFile(), true);
});

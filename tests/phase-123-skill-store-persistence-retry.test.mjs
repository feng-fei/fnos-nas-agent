import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rename, chmod, unlink, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillStore } from "../apps/fnos-nas-agent/app/skills.mjs";

const nativeStoreFs = { mkdir, readFile, writeFile, rename, chmod, unlink };

function registration(name, digit) {
  return {
    name,
    archiveSha256: digit.repeat(64),
    quarantineFile: `skill-quarantine/${digit.repeat(64)}.zip`,
    archiveSizeBytes: 100,
    archiveEntryCount: 1,
    declaredUncompressedBytes: 100
  };
}

test("Skill inventory persistence recovers after a write fails and removes the orphan temp file", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-skill-store-retry-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let failOnce = true;
  const fs = {
    ...nativeStoreFs,
    async writeFile(path, data, options) {
      await writeFile(path, data, options);
      if (failOnce) {
        failOnce = false;
        throw Object.assign(new Error("simulated disk full after temp creation"), { code: "ENOSPC" });
      }
    }
  };
  const store = createSkillStore(dataDir, { fs });

  await assert.rejects(store.register(registration("First skill", "a")), error =>
    error?.statusCode === 500 && /Unable to save Skill metadata securely/.test(error.message));

  const afterFailure = await readdir(dataDir);
  assert.deepEqual(afterFailure, [], "failed temp file should be removed");

  const saved = await store.register(registration("Second skill", "b"));
  assert.equal(saved.name, "Second skill");
  assert.equal(failOnce, false);

  const inventory = JSON.parse(await readFile(join(dataDir, "skills.json"), "utf8"));
  assert.deepEqual(inventory.map(item => item.name), ["Second skill"]);
  assert.equal((await readdir(dataDir)).some(name => name.endsWith(".tmp")), false);

  const restarted = createSkillStore(dataDir);
  await restarted.load();
  const list = restarted.list();
  assert.equal(list.total, 1);
  assert.equal(list.skills[0].name, "Second skill");
});

test("Skill inventory persistence uses exclusive unique temp files for concurrent registrations", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-skill-store-concurrent-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = createSkillStore(dataDir);
  const results = await Promise.all([
    store.register(registration("Concurrent A", "c")),
    store.register(registration("Concurrent B", "d"))
  ]);
  assert.equal(results.length, 2);
  const restarted = createSkillStore(dataDir);
  await restarted.load();
  assert.deepEqual(restarted.list().skills.map(item => item.name).sort(), ["Concurrent A", "Concurrent B"]);
  assert.equal((await readdir(dataDir)).filter(name => name.endsWith(".tmp")).length, 0);
});

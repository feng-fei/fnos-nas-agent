/**
 * Phase 169: the contract of the runbook library.
 *
 * The tests use the real file system in a temporary directory and an injected
 * file system to simulate a failing write. There is no network, no clock
 * beyond the injected one and no third party dependency.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunbookStore, redactRunbookText, RUNBOOK_ID_PATTERN } from "../apps/fnos-nas-agent/app/runbook-store.mjs";

const CLOCK = () => "2026-01-01T00:00:00.000Z";

function entry(overrides = {}) {
  return { id: "disk-usage", title: "Disk usage check", tags: ["storage", "ops"], body: "Run the read only diagnostics and read the storage pool table.", ...overrides };
}

async function withTempDir(work) {
  const dir = await mkdtemp(join(tmpdir(), "runbook-store-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("an entry is written and read back", async () => {
  const store = createRunbookStore({ now: CLOCK });
  const result = await store.put(entry());
  assert.equal(result.written, true);
  assert.equal(result.entry.id, "disk-usage");
  assert.deepEqual(result.entry.tags, ["storage", "ops"]);

  const read = store.get("disk-usage");
  assert.equal(read.title, "Disk usage check");
  assert.equal(read.body.includes("storage pool"), true);
  assert.equal(store.get("missing"), null);
});

test("an illegal id is refused and nothing is written", async () => {
  const store = createRunbookStore({ now: CLOCK });
  for (const id of ["", "Disk Usage", "-leading", "a".repeat(65), "with space"]) {
    const result = await store.put(entry({ id }));
    assert.equal(result.written, false);
    assert.equal(result.code, "invalid-id");
  }
  assert.equal(RUNBOOK_ID_PATTERN.test("disk-usage.v2_final"), true);
  assert.equal(store.stats().count, 0);
});

test("an existing id is never overwritten", async () => {
  const store = createRunbookStore({ now: CLOCK });
  await store.put(entry());
  const second = await store.put(entry({ title: "Other title", body: "Other body" }));
  assert.equal(second.written, false);
  assert.equal(second.code, "duplicate-entry");
  assert.equal(store.get("disk-usage").title, "Disk usage check");
});

test("an empty title, an empty body and an oversized body are refused", async () => {
  const store = createRunbookStore({ now: CLOCK });
  assert.equal((await store.put(entry({ title: "   " }))).code, "invalid-title");
  assert.equal((await store.put(entry({ body: "  " }))).code, "invalid-body");
  const large = await store.put(entry({ body: "x".repeat(64 * 1024 + 1) }));
  assert.equal(large.written, false);
  assert.equal(large.code, "body-too-large");
  assert.equal(store.stats().count, 0);
});

test("the library does not grow beyond its limit", async () => {
  const store = createRunbookStore({ now: CLOCK, maxEntries: 2 });
  await store.put(entry({ id: "one" }));
  await store.put(entry({ id: "two" }));
  const third = await store.put(entry({ id: "three" }));
  assert.equal(third.written, false);
  assert.equal(third.code, "max-entries-reached");
  assert.equal(store.stats().count, 2);
});

test("the list filters by tag and paginates", () => {
  const store = createRunbookStore({ now: CLOCK });
  return Promise.all([
    store.put(entry({ id: "a", tags: ["storage"] })),
    store.put(entry({ id: "b", tags: ["network"] })),
    store.put(entry({ id: "c", tags: ["storage", "network"] }))
  ]).then(() => {
    const all = store.list();
    assert.equal(all.total, 3);
    assert.equal(all.entries.length, 3);
    const filtered = store.list({ tag: "storage" });
    assert.equal(filtered.total, 2);
    assert.deepEqual(filtered.entries.map(item => item.id).sort(), ["a", "c"]);
    const page = store.list({ limit: 1, offset: 1 });
    assert.equal(page.entries.length, 1);
    assert.equal(page.total, 3);
  });
});

test("a search finds title, tag and body and keeps a stable order", async () => {
  const store = createRunbookStore({ now: CLOCK });
  await store.put(entry({ id: "storage-pool", title: "Storage pool health", tags: ["storage"], body: "Check the storage pool and the volume table." }));
  await store.put(entry({ id: "network-check", title: "Network check", tags: ["network"], body: "Check the storage link of the ethernet port." }));
  await store.put(entry({ id: "unrelated", title: "Coffee", tags: ["misc"], body: "Nothing to do with a server." }));

  // Every token of the query has to be found, so "storage pool" needs both.
  const byTitle = store.search("storage pool");
  assert.equal(byTitle.total, 1);
  assert.equal(byTitle.results[0].id, "storage-pool");
  assert.equal(byTitle.results[0].snippet.length > 0, true);

  const singleToken = store.search("storage");
  assert.equal(singleToken.total, 2);
  assert.deepEqual(singleToken.results.map(item => item.id).sort(), ["network-check", "storage-pool"]);

  const byTag = store.search("network");
  assert.equal(byTag.total, 1);
  assert.equal(byTag.results[0].id, "network-check");

  const byBody = store.search("ethernet");
  assert.equal(byBody.total, 1);
  assert.equal(byBody.results[0].id, "network-check");

  const nothing = store.search("kubernetes");
  assert.equal(nothing.total, 0);
  assert.deepEqual(nothing.results, []);

  // The same query twice gives the same order.
  const first = store.search("storage").results.map(item => item.id);
  const second = store.search("storage").results.map(item => item.id);
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
});

test("an entry is removed and the removal is reported", async () => {
  const store = createRunbookStore({ now: CLOCK });
  await store.put(entry());
  const removed = await store.remove("disk-usage");
  assert.equal(removed.removed, true);
  assert.equal(store.get("disk-usage"), null);
  const again = await store.remove("disk-usage");
  assert.equal(again.removed, false);
  assert.equal(again.code, "not-found");
});

test("the stats report the entries, the tags and the update time", async () => {
  const store = createRunbookStore({ now: CLOCK });
  await store.put(entry({ tags: ["storage", "ops"] }));
  await store.put(entry({ id: "second", tags: ["ops"] }));
  const stats = store.stats();
  assert.equal(stats.count, 2);
  assert.deepEqual(stats.tags, ["ops", "storage"]);
  assert.equal(stats.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(stats.maxEntries, 500);
  assert.equal(stats.persisted, false);
});

test("a credential field is filtered and only the field name is kept", async () => {
  const store = createRunbookStore({ now: CLOCK });
  const result = await store.put(entry({
    body: "Set apiKey: sk-abcdefghijklmnopqrstuvwx and password = \"hunter2\" before the test. The token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 belongs to nobody."
  }));
  assert.equal(result.written, true);
  const stored = store.get("disk-usage");
  assert.equal(stored.body.includes("sk-abcdefghijklmnopqrstuvwx"), false);
  assert.equal(stored.body.includes("hunter2"), false);
  assert.equal(stored.body.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), false);
  assert.equal(stored.body.includes("[已隐藏]"), true);
  assert.equal(stored.redactedFields.includes("apikey"), true);
  assert.equal(stored.redactedFields.includes("password"), true);
  // The field name is recorded, never the value.
  assert.equal(stored.redactedFields.some(name => name.includes("sk-")), false);
  assert.equal(result.redactedFields.includes("apikey"), true);
});

test("the redaction helper keeps a harmless text untouched", () => {
  const clean = redactRunbookText("Read the storage pool and report the volume table.");
  assert.equal(clean.text, "Read the storage pool and report the volume table.");
  assert.deepEqual(clean.fields, []);
});

test("a persistent store writes the file and reads it back", async () => {
  await withTempDir(async (dir) => {
    const store = createRunbookStore({ dataDir: dir, now: CLOCK });
    await store.load();
    await store.put(entry());
    const raw = await readFile(join(dir, "runbooks.json"), "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0].id, "disk-usage");

    const second = createRunbookStore({ dataDir: dir, now: CLOCK });
    await second.load();
    assert.equal(second.stats().count, 1);
    assert.equal(second.get("disk-usage").title, "Disk usage check");
  });
});

test("a failing write keeps the data that is already there", async () => {
  await withTempDir(async (dir) => {
    const store = createRunbookStore({ dataDir: dir, now: CLOCK });
    await store.load();
    await store.put(entry());

    const before = await readFile(join(dir, "runbooks.json"), "utf8");
    const failing = {
      open: (await import("node:fs/promises")).open,
      mkdir: (await import("node:fs/promises")).mkdir,
      chmod: (await import("node:fs/promises")).chmod,
      unlink: (await import("node:fs/promises")).unlink,
      readFile: (await import("node:fs/promises")).readFile,
      rename: async () => { throw new Error("disk is full"); }
    };
    const broken = createRunbookStore({ dataDir: dir, now: CLOCK, fs: failing });
    await broken.load();
    const result = await broken.put(entry({ id: "second-entry", body: "This one never reaches the disk." }));
    assert.equal(result.written, false);
    assert.equal(result.code, "persist-failed");

    const after = await readFile(join(dir, "runbooks.json"), "utf8");
    assert.equal(after, before);
    // The temporary file of the failed write is gone.
    const leftovers = (await readdir(dir)).filter(name => name.startsWith(".runbooks-"));
    assert.deepEqual(leftovers, []);
  });
});

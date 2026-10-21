import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBrowser } from "../apps/fnos-nas-agent/app/file-browser.mjs";

test("file browser lists bounded metadata with directories first", async () => {
  const temp = await mkdtemp(join(tmpdir(), "fnos-browser-"));
  try {
    const root = join(temp, "vol1");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "z.txt"), "hello");
    await writeFile(join(root, "a.txt"), "world");
    const browser = createFileBrowser({ roots: [root] });
    const result = await browser.list(root, 1);
    assert.equal(result.path, root);
    assert.equal(result.totalEntries, 3);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].type, "directory");
    assert.equal(result.entries[0].name, "docs");
    assert.equal(result.parentPath, null);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("file browser refuses paths outside configured roots", async () => {
  const temp = await mkdtemp(join(tmpdir(), "fnos-browser-"));
  try {
    const root = join(temp, "vol1"), outside = join(temp, "private");
    await mkdir(root); await mkdir(outside);
    const browser = createFileBrowser({ roots: [root] });
    await assert.rejects(browser.list(outside), error => error.statusCode === 403);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("file browser skips symlinks and refuses a symlink that escapes the volume", async () => {
  const temp = await mkdtemp(join(tmpdir(), "fnos-browser-"));
  try {
    const root = join(temp, "vol1"), outside = join(temp, "outside");
    await mkdir(root); await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "escape"));
    const browser = createFileBrowser({ roots: [root] });
    const result = await browser.list(root);
    assert.deepEqual(result.entries, []);
    await assert.rejects(browser.list(join(root, "escape")), error => error.statusCode === 403);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("file browser returns an empty list when no storage root is available", async () => {
  const browser = createFileBrowser({ roots: [] });
  const result = await browser.list();
  assert.deepEqual(result.roots, []);
  assert.deepEqual(result.entries, []);
});

test("file browser searches names with bounded traversal and ignores symlinks", async () => {
  const temp = await mkdtemp(join(tmpdir(), "fnos-browser-search-"));
  try {
    const root = join(temp, "vol1"), docs = join(root, "资料");
    await mkdir(docs, { recursive: true });
    await mkdir(join(docs, "nested"));
    await writeFile(join(docs, "report-2026.txt"), "report");
    await writeFile(join(docs, "nested", "REPORT-old.txt"), "old");
    await writeFile(join(root, "private-key.txt"), "outside query");
    await symlink(join(temp, "outside"), join(docs, "link"));
    const browser = createFileBrowser({ roots: [root] });
    const result = await browser.search(docs, "report", 10);
    assert.equal(result.query, "report");
    assert.equal(result.entries.length, 2);
    assert.deepEqual(result.entries.map(x => x.name).sort(), ["REPORT-old.txt", "report-2026.txt"]);
    assert.ok(result.scanned <= 5000);
    await assert.rejects(browser.search(join(temp, "outside"), "secret"), error => error.statusCode === 403 || error.statusCode === 404);
    await assert.rejects(browser.search(docs, ""), error => error.statusCode === 400);
    const limited = await browser.search(root, "txt", 1);
    assert.equal(limited.entries.length, 1);
    assert.equal(limited.truncated, true);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

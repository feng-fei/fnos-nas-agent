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

test("file browser paginates sorted entries with bounded offsets", async () => {
  const temp = await mkdtemp(join(tmpdir(), "fnos-browser-pages-"));
  try {
    const root = join(temp, "vol1");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "z.txt"), "z");
    await writeFile(join(root, "a.txt"), "a");
    const browser = createFileBrowser({ roots: [root] });
    const first = await browser.list(root, 2, 0);
    const second = await browser.list(root, 2, 2);
    assert.equal(first.totalEntries, 3);
    assert.equal(first.offset, 0);
    assert.deepEqual(first.entries.map(item => item.name), ["docs", "a.txt"]);
    assert.equal(second.offset, 2);
    assert.deepEqual(second.entries.map(item => item.name), ["z.txt"]);
    assert.equal((await browser.list(root, 2, 999999)).entries.length, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("file browser applies name/type filters and sort before slicing pages", async () => {
  const temp = await mkdtemp(join(tmpdir(), "fnos-browser-filter-pages-"));
  try {
    const root = join(temp, "vol1");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "z.txt"), "z");
    await writeFile(join(root, "a.txt"), "a");
    const browser = createFileBrowser({ roots: [root] });
    const first = await browser.list(root, 1, 0, "name-asc");
    const second = await browser.list(root, 1, 1, "name-asc");
    assert.equal(first.entries[0].name, "a.txt");
    assert.equal(second.entries[0].name, "docs");
    const search = await browser.list(root, 10, 0, "name-asc", "z", "file");
    assert.equal(search.totalDirectoryEntries, 3);
    assert.equal(search.totalEntries, 1);
    assert.equal(search.entries[0].name, "z.txt");
    await assert.rejects(browser.list(root, 10, 0, "invalid"), { statusCode: 400 });
  } finally { await rm(temp, { recursive: true, force: true }); }
});


test("content search finds text matches within allowed roots and redacts credential snippets", async () => {
  const temp = await mkdtemp(join(tmpdir(), "fnos-content-search-"));
  try {
    const root = join(temp, "vol1");
    const docs = join(root, "docs");
    const outside = join(temp, "outside");
    await mkdir(docs, { recursive: true });
    await mkdir(outside);
    await writeFile(join(docs, "guide.md"), "存储方案：使用 5 GB 缓冲。\nAPI_KEY = \"super-secret-value\"\n");
    await writeFile(join(docs, ".env"), "APP_TOKEN=hidden-env-value\n");
    await writeFile(join(docs, "database-password.txt"), "password=hidden-password-value\n");
    await writeFile(join(docs, "binary.txt"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(outside, "external.md"), "外部目录中不应出现 TARGETWORD");
    await symlink(join(outside, "external.md"), join(docs, "external.md"));
    const browser = createFileBrowser({ roots: [root] });

    const found = await browser.searchContent(docs, "5 GB");
    assert.equal(found.entries.length, 1);
    assert.equal(found.entries[0].name, "guide.md");
    assert.equal(found.entries[0].lineNumber, 1);
    assert.match(found.entries[0].snippet, /5 GB/);
    assert.equal(found.truncated, false);

    const secret = await browser.searchContent(docs, "api_key");
    assert.equal(secret.entries.length, 1);
    assert.match(secret.entries[0].snippet, /已隐藏/);
    assert.doesNotMatch(JSON.stringify(secret), /super-secret-value/);

    const skippedSecret = await browser.searchContent(docs, "hidden-env-value");
    assert.equal(skippedSecret.entries.length, 0);
    const skippedPasswordFile = await browser.searchContent(docs, "hidden-password-value");
    assert.equal(skippedPasswordFile.entries.length, 0);
    const skippedSymlink = await browser.searchContent(docs, "TARGETWORD");
    assert.equal(skippedSymlink.entries.length, 0);
    assert.ok(found.bytesRead <= 2 * 1024 * 1024);
    await assert.rejects(browser.searchContent(outside, "TARGETWORD"), error => error.statusCode === 403 || error.statusCode === 404);
    await assert.rejects(browser.searchContent(docs, ""), { statusCode: 400 });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("content search skips oversized files and reports traversal limits", async () => {
  const temp = await mkdtemp(join(tmpdir(), "fnos-content-search-bounds-"));
  try {
    const root = join(temp, "vol1");
    await mkdir(root);
    await writeFile(join(root, "large.md"), "needle " + "x".repeat(300 * 1024));
    const browser = createFileBrowser({ roots: [root] });
    const result = await browser.searchContent(root, "needle");
    assert.equal(result.entries.length, 0);
    assert.equal(result.skippedLargeFiles, 1);
    assert.equal(result.truncated, false);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

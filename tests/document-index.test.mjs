import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalDocumentIndex } from "../apps/fnos-nas-agent/app/document-index.mjs";

function fixture() {
  const roots = [{ name: "vol1", path: "/vol1" }];
  const content = new Map([
    ["/vol1/README.md", "NAS 使用指南\n如何查看存储状态和 Docker 容器。"],
    ["/vol1/docs/budget.md", "家庭预算规划\n2026 家庭预算和季度计划。\nAPI_KEY=ultra-secret-value"],
    ["/vol1/docs/ledger.csv", "日期,分类\n2026-01,家庭预算"],
    ["/vol1/.env", "API_KEY=must-not-be-indexed"],
    ["/vol1/token-export.txt", "secret token must not be indexed"],
    ["/vol1/docs/secret-password.txt", "must not be indexed"],
    ["/vol1/docs/large.md", "x".repeat(70 * 1024)]
  ]);
  const modified = new Map([...content.keys()].map(path => [path, "2026-10-20T00:00:00.000Z"]));
  const size = path => Buffer.byteLength(content.get(path) || "", "utf8");
  function entry(path, type) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return { name, path, type, sizeBytes: type === "file" ? size(path) : null, modifiedAt: modified.get(path) || "2026-10-20T00:00:00.000Z" };
  }
  const directories = {
    "/vol1": [
      entry("/vol1/README.md", "file"),
      entry("/vol1/.env", "file"),
      entry("/vol1/token-export.txt", "file"),
      entry("/vol1/docs", "directory")
    ],
    "/vol1/docs": [
      entry("/vol1/docs/budget.md", "file"),
      entry("/vol1/docs/ledger.csv", "file"),
      entry("/vol1/docs/secret-password.txt", "file"),
      entry("/vol1/docs/large.md", "file")
    ]
  };
  const previewCalls = [];
  const browser = {
    async list(path = "", limit = 100, offset = 0) {
      const actual = path || "/vol1";
      const entries = directories[actual] || [];
      return { roots, path: actual, entries: entries.slice(offset, offset + limit), totalEntries: entries.length, truncated: false };
    }
  };
  const fileManager = {
    async preview(path) {
      previewCalls.push(path);
      if (!content.has(path)) throw Object.assign(new Error("missing"), { statusCode: 404 });
      return { path, name: path.slice(path.lastIndexOf("/") + 1), content: content.get(path) };
    }
  };
  return { content, modified, directories, previewCalls, size, browser, fileManager };
}

test("local document index refreshes text files, excludes secrets and searches redacted excerpts", async () => {
  const temp = await mkdtemp(join(tmpdir(), "fnos-document-index-"));
  try {
    const f = fixture();
    const index = createLocalDocumentIndex({ dataDir: temp, fileBrowser: f.browser, fileManager: f.fileManager });
    const first = await index.refresh({ maxFiles: 100 });
    assert.equal(first.documentCount, 3);
    assert.equal(first.partial, false);
    assert.ok(first.lastRefresh.updatedCount >= 3);
    const search = await index.search("家庭预算", 10);
    assert.ok(search.results.some(item => item.path === "/vol1/docs/budget.md"));
    assert.ok(search.results.some(item => item.path === "/vol1/docs/ledger.csv"));
    assert.ok(!JSON.stringify(search).includes("ultra-secret-value"));
    assert.ok(!JSON.stringify(search).includes("must-not-be-indexed"));
    assert.ok(!search.results.some(item => item.path.includes(".env") || item.path.includes("secret-password")));
    const mode = (await stat(join(temp, "document-index.json"))).mode & 0o777;
    assert.equal(mode, 0o600);
    const status = await index.status();
    assert.equal(status.documentCount, 3);
    assert.equal(status.storage, "private local app data");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("local document index skips unchanged files, refreshes changed metadata and persists across instances", async () => {
  const temp = await mkdtemp(join(tmpdir(), "fnos-document-index-incremental-"));
  try {
    const f = fixture();
    const index = createLocalDocumentIndex({ dataDir: temp, fileBrowser: f.browser, fileManager: f.fileManager });
    const first = await index.refresh({ maxFiles: 100 });
    const initialCalls = f.previewCalls.length;
    const second = await index.refresh({ maxFiles: 100 });
    assert.equal(second.lastRefresh.updatedCount, 0);
    assert.ok(second.lastRefresh.unchangedCount >= 3);
    assert.equal(f.previewCalls.length, initialCalls);

    f.content.set("/vol1/docs/budget.md", "季度投资计划\n2027 年规划。");
    f.modified.set("/vol1/docs/budget.md", "2026-10-22T00:00:00.000Z");
    f.directories["/vol1/docs"][0].sizeBytes = f.size("/vol1/docs/budget.md");
    f.directories["/vol1/docs"][0].modifiedAt = f.modified.get("/vol1/docs/budget.md");

    const third = await index.refresh({ maxFiles: 100 });
    assert.ok(third.lastRefresh.updatedCount >= 1);
    assert.equal((await index.search("季度投资", 10)).results[0].path, "/vol1/docs/budget.md");
    assert.ok(!(await index.search("家庭预算", 10)).results.some(item => item.path === "/vol1/docs/budget.md"));

    const restarted = createLocalDocumentIndex({ dataDir: temp, fileBrowser: f.browser, fileManager: f.fileManager });
    assert.equal((await restarted.status()).documentCount, 3);
    const forced = await restarted.refresh({ force: true, maxFiles: 100 });
    assert.ok(forced.lastRefresh.updatedCount >= 3);
    assert.equal(first.documentCount, 3);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("local document index validates query and refresh limits", async () => {
  const temp = await mkdtemp(join(tmpdir(), "fnos-document-index-validation-"));
  try {
    const f = fixture();
    const index = createLocalDocumentIndex({ dataDir: temp, fileBrowser: f.browser, fileManager: f.fileManager });
    await assert.rejects(index.search("", 10), { statusCode: 400 });
    await assert.rejects(index.search("query", 21), { statusCode: 400 });
    await assert.rejects(index.refresh({ maxFiles: 501 }), { statusCode: 400 });
    await assert.rejects(index.refresh({ force: "yes" }), { statusCode: 400 });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

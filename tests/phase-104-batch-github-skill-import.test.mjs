import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importGitHubSkillBatch } from "../apps/fnos-nas-agent/app/skill-remote-import-batch.mjs";

const eightBytes = Buffer.from([80, 75, 3, 4, 0, 0, 0, 0]);
function makeArchive(repo, overrides = {}) {
  return {
    buffer: eightBytes,
    bytes: eightBytes.length,
    repository: repo,
    branch: "main",
    refType: "heads",
    commitSha: "a".repeat(40),
    ...overrides
  };
}
function makeSkill(input, index = 1) {
  return {
    id: String(index).padStart(24, "0"),
    name: input.name,
    state: "pending_review",
    archiveSha256: "b".repeat(64),
    manifestReview: { status: "needs_review", findings: [] }
  };
}

test("batch import downloads sequentially and shares one cumulative byte budget", async () => {
  const calls = [], imports = [];
  const result = await importGitHubSkillBatch([
    { url: "https://github.com/example/one" },
    { url: "https://github.com/example/two", version: "v2" },
    { url: "https://github.com/example/three" }
  ], {
    maxTotalBytes: 16,
    fetchArchive: async (url, options) => {
      calls.push({ url, maxBytes: options.maxBytes });
      return makeArchive("example/" + url.split("/").at(-1));
    },
    importArchive: async (input, buffer) => {
      imports.push({ input, buffer });
      return makeSkill(input, imports.length);
    }
  });
  assert.deepEqual(calls, [
    { url: "https://github.com/example/one", maxBytes: 16 },
    { url: "https://github.com/example/two", maxBytes: 8 }
  ]);
  assert.equal(imports.length, 2);
  assert.equal(imports[0].input.name, "one", "name is derived from repository when omitted");
  assert.equal(imports[1].input.version, "v2");
  assert.ok(imports[0].input.sourceLabel.includes("#" + "a".repeat(40)));
  assert.equal(result.total, 3);
  assert.equal(result.importedCount, 2);
  assert.equal(result.failedCount, 1);
  assert.equal(result.downloadedBytes, 16);
  assert.equal(result.results[2].skipped, true);
  assert.equal(result.results[2].ok, false);
});

test("one item failure does not cancel later independent imports", async () => {
  const calls = [], imported = [];
  const result = await importGitHubSkillBatch([
    { url: "https://github.com/example/bad" },
    { url: "https://github.com/example/good" }
  ], {
    maxTotalBytes: 64,
    fetchArchive: async url => {
      calls.push(url);
      if (url.endsWith("/bad")) throw Object.assign(new Error("GitHub archive download failed with HTTP 404."), {
        statusCode: 502, code: "SKILL_REMOTE_HTTP_FAILED"
      });
      return makeArchive("example/good");
    },
    importArchive: async input => { imported.push(input.name); return makeSkill(input); }
  });
  assert.deepEqual(calls, ["https://github.com/example/bad", "https://github.com/example/good"]);
  assert.deepEqual(imported, ["good"]);
  assert.equal(result.importedCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[1].ok, true);
});

test("a size-limit failure consumes the remaining budget and skips later downloads", async () => {
  const calls = [];
  const result = await importGitHubSkillBatch([
    { url: "https://github.com/example/too-big" },
    { url: "https://github.com/example/second" }
  ], {
    maxTotalBytes: 64,
    fetchArchive: async url => {
      calls.push(url);
      throw Object.assign(new Error("GitHub ZIP archive exceeds the 25 MiB import limit."), {
        statusCode: 413, code: "SKILL_REMOTE_TOO_LARGE"
      });
    },
    importArchive: async input => makeSkill(input)
  });
  assert.deepEqual(calls, ["https://github.com/example/too-big"]);
  assert.equal(result.downloadedBytes, 64);
  assert.equal(result.results[1].skipped, true);
});

test("batch input rejects empty or oversized lists and validates each item without throwing", async () => {
  const fetchCalls = [];
  const options = {
    maxTotalBytes: 64,
    fetchArchive: async url => { fetchCalls.push(url); return makeArchive("example/ok"); },
    importArchive: async input => makeSkill(input)
  };
  await assert.rejects(importGitHubSkillBatch([], options), { statusCode: 400 });
  await assert.rejects(importGitHubSkillBatch(Array.from({ length: 6 }, (_, i) => ({ url: "https://github.com/example/" + i })), options), { statusCode: 400 });
  const result = await importGitHubSkillBatch([
    { url: "" },
    { url: "https://github.com/example/ok" },
    { url: "https://github.com/example/ok" },
    { url: "https://github.com/example/ok", name: "x".repeat(101) },
    { url: "https://github.com/example/ok", version: "v".repeat(41) }
  ], options);
  assert.equal(result.total, 5);
  assert.equal(result.importedCount, 1);
  assert.equal(result.failedCount, 4);
  assert.equal(fetchCalls.length, 1);
});

test("batch import rejects inconsistent archive byte metadata without storing it", async () => {
  let imports = 0;
  const result = await importGitHubSkillBatch([{ url: "https://github.com/example/invalid" }], {
    maxTotalBytes: 64,
    fetchArchive: async () => makeArchive("example/invalid", { bytes: 9 }),
    importArchive: async input => { imports++; return makeSkill(input); }
  });
  assert.equal(imports, 0);
  assert.equal(result.importedCount, 0);
  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].error, /invalid size metadata/i);
});

test("batch API and mobile UI enforce authenticated sequential quarantine import", async () => {
  const server = await readFile(new URL("../apps/fnos-nas-agent/app/server.mjs", import.meta.url), "utf8");
  const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");
  const routeStart = server.indexOf('if (url.pathname === "/api/skills/import-remote-batch")');
  const routeEnd = server.indexOf('if (url.pathname === "/api/skills/transitions/batch")', routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart, "batch API must be registered before other skill transition routes");
  const route = server.slice(routeStart, routeEnd);
  assert.match(route, /sessionFor\(req\)/);
  assert.match(route, /sameOrigin\(req\)/);
  assert.match(route, /skillRemoteImportLimiter\.allow/);
  assert.match(route, /importGitHubSkillBatch\(body\.items/);
  assert.match(route, /skillStore\.importArchive\(input, archiveBuffer\)/);
  assert.match(route, /no extraction or execution occurred/);
  assert.match(server, /import-remote-batch.*skills\.import/);
  assert.match(html, /id="skill-remote-batch-form"/);
  assert.match(html, /id="skill-remote-batch-urls"/);
  assert.match(html, /split\(\/\\r\?\\n\//);
  assert.match(html, /api\("\/api\/skills\/import-remote-batch"/);
  assert.match(html, /25 MiB 累计下载上限/);
});

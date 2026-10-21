import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fetchGitHubSkillArchive, validateGitHubArchiveUrl, validateGitHubRepositoryUrl } from "../apps/fnos-nas-agent/app/skill-remote-import.mjs";

const githubUrl = "https://github.com/example/project/archive/refs/heads/main.zip";
const codeloadUrl = "https://codeload.github.com/example/project/legacy.zip/refs/heads/main";

test("GitHub archive URL validator accepts only well-formed branch/tag ZIP URLs", () => {
  assert.equal(validateGitHubArchiveUrl(githubUrl).repository, "example/project");
  assert.equal(validateGitHubArchiveUrl(codeloadUrl).repository, "example/project");
  for (const value of [
    "http://github.com/example/project/archive/refs/heads/main.zip",
    "https://evil.example/example/project/archive/refs/heads/main.zip",
    "https://github.com@example.com/example/project/archive/refs/heads/main.zip",
    "https://github.com/example/project/archive/refs/heads/main.zip?token=secret",
    "https://github.com/example/project/archive/refs/heads/main.zip#fragment",
    "https://github.com/example/project",
    "https://github.com/example/project/archive/../../secret.zip",
    "https://127.0.0.1/example/project/archive/refs/heads/main.zip"
  ]) assert.throws(() => validateGitHubArchiveUrl(value));
});

test("remote import follows GitHub-to-codeload redirect and bounds the downloaded archive", async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url === githubUrl) return new Response(null, { status: 302, headers: { location: codeloadUrl } });
    return new Response(Buffer.from([80, 75, 3, 4, 102, 97, 107, 101]), { status: 200, headers: { "content-length": "8" } });
  };
  const result = await fetchGitHubSkillArchive(githubUrl, { fetchImpl, maxBytes: 64 });
  assert.equal(result.repository, "example/project");
  assert.equal(result.sourceUrl, githubUrl);
  assert.equal(result.redirects, 1);
  assert.equal(result.bytes, 8);
  assert.deepEqual(calls, [githubUrl, codeloadUrl]);
});

test("remote import blocks redirects outside the GitHub archive allowlist", async () => {
  await assert.rejects(
    fetchGitHubSkillArchive(githubUrl, { fetchImpl: async () => new Response(null, {
      status: 302, headers: { location: "http://127.0.0.1:18787/private" }
    }) }),
    error => error.statusCode === 502 && error.code === "SKILL_REMOTE_REDIRECT_INVALID"
  );
});

test("remote import rejects declared and streamed archives larger than its limit", async () => {
  await assert.rejects(
    fetchGitHubSkillArchive(githubUrl, { maxBytes: 4, fetchImpl: async () => new Response("12345", {
      status: 200, headers: { "content-length": "5" }
    }) }),
    error => error.statusCode === 413 && error.code === "SKILL_REMOTE_TOO_LARGE"
  );
  await assert.rejects(
    fetchGitHubSkillArchive(githubUrl, { maxBytes: 4, fetchImpl: async () => new Response("12345", { status: 200 }) }),
    error => error.statusCode === 413 && error.code === "SKILL_REMOTE_TOO_LARGE"
  );
});

test("remote import rejects non-success and empty upstream responses without exposing bodies", async () => {
  await assert.rejects(
    fetchGitHubSkillArchive(githubUrl, { fetchImpl: async () => new Response("private upstream diagnostic", { status: 403 }) }),
    /HTTP 403/
  );
  await assert.rejects(
    fetchGitHubSkillArchive(githubUrl, { fetchImpl: async () => new Response(null, { status: 200 }) }),
    error => error.code === "SKILL_REMOTE_EMPTY"
  );
});

test("remote Skill import is wired through authenticated quarantine flow and mobile UI", async () => {
  const server = await readFile(new URL("../apps/fnos-nas-agent/app/server.mjs", import.meta.url), "utf8");
  const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");
  const start = server.indexOf('if (url.pathname === "/api/skills/import-remote")');
  const end = server.indexOf('if (url.pathname === "/api/skills/transitions/batch")', start);
  assert.ok(start >= 0 && end > start, "remote import route must be registered");
  const route = server.slice(start, end);
  assert.match(route, /sessionFor\(req\)/);
  assert.match(route, /sameOrigin\(req\)/);
  assert.match(route, /skillRemoteImportLimiter\.allow/);
  assert.match(route, /fetchGitHubSkillArchive\(body\.url/);
  assert.match(route, /skillStore\.importArchive\(\{ name, version, sourceLabel \}, archive\.buffer\)/);
  assert.match(route, /no extraction or execution occurred/);
  assert.match(html, /id="skill-remote-import-form"/);
  assert.match(html, /id="skill-remote-url" type="url" maxlength="2048"/);
  assert.match(html, /api\("\/api\/skills\/import-remote"/);
  assert.match(html, /尚未解压或执行/);
});

test("plain GitHub repository URLs resolve the default branch and use the existing ZIP quarantine flow", async () => {
  const repoUrl = "https://github.com/example/project";
  const apiUrl = "https://api.github.com/repos/example/project";
  const archiveUrl = "https://github.com/example/project/archive/refs/heads/main.zip";
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url === apiUrl) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    if (url === archiveUrl) return new Response(null, { status: 302, headers: { location: codeloadUrl } });
    if (url === codeloadUrl) return new Response(Buffer.from([80, 75, 3, 4, 102, 97, 107, 101]), { status: 200, headers: { "content-length": "8" } });
    throw new Error("unexpected URL");
  };
  const result = await fetchGitHubSkillArchive(repoUrl, { fetchImpl, maxBytes: 64 });
  assert.equal(result.repository, "example/project");
  assert.equal(result.sourceUrl, repoUrl);
  assert.equal(result.branch, "main");
  assert.equal(result.resolvedFromRepository, true);
  assert.equal(result.bytes, 8);
  assert.deepEqual(calls, [apiUrl, archiveUrl, codeloadUrl]);
});

test("GitHub repository shortcut rejects unsafe or malformed default-branch metadata before archive download", async () => {
  let calls = 0;
  await assert.rejects(
    fetchGitHubSkillArchive("https://github.com/example/project", {
      fetchImpl: async () => { calls++; return new Response(JSON.stringify({ default_branch: "../../private" }), { status: 200 }); }
    }),
    error => error.code === "SKILL_REMOTE_BRANCH_INVALID"
  );
  assert.equal(calls, 1);
  assert.throws(() => validateGitHubRepositoryUrl("https://github.com/example/project/tree/main"));
  assert.throws(() => validateGitHubRepositoryUrl("https://github.com.example/owner/repo"));
});

test("GitHub repository metadata failures never expose upstream response bodies", async () => {
  await assert.rejects(
    fetchGitHubSkillArchive("https://github.com/example/project", {
      fetchImpl: async () => new Response("private upstream secret", { status: 403 })
    }),
    error => error.code === "SKILL_REMOTE_LOOKUP_FAILED" && !error.message.includes("private upstream secret")
  );
});

test("GitHub archive validation preserves branch or tag provenance across archive host redirects", () => {
  const branch = validateGitHubArchiveUrl(githubUrl);
  const tag = validateGitHubArchiveUrl("https://github.com/example/project/archive/refs/tags/v1.2.3.zip");
  const codeloadBranch = validateGitHubArchiveUrl(codeloadUrl);
  assert.deepEqual({ type: branch.refType, ref: branch.ref }, { type: "heads", ref: "main" });
  assert.deepEqual({ type: tag.refType, ref: tag.ref }, { type: "tags", ref: "v1.2.3" });
  assert.deepEqual({ type: codeloadBranch.refType, ref: codeloadBranch.ref }, { type: "heads", ref: "main" });
});

test("remote Skill import persists repository plus branch/tag as source provenance", async () => {
  const server = await readFile(new URL("../apps/fnos-nas-agent/app/server.mjs", import.meta.url), "utf8");
  const routeStart = server.indexOf('if (url.pathname === "/api/skills/import-remote")');
  const routeEnd = server.indexOf('if (url.pathname === "/api/skills/transitions/batch")', routeStart);
  const route = server.slice(routeStart, routeEnd);
  assert.match(route, /"GitHub: " \+ archive\.repository \+ \(archive\.refType && archive\.branch \? "@" \+ archive\.refType \+ "\/" \+ archive\.branch/);
  assert.match(route, /refType: archive\.refType/);
});

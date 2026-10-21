import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fetchGitHubSkillArchive, validateGitHubArchiveUrl, validateGitHubRepositoryUrl } from "../apps/fnos-nas-agent/app/skill-remote-import.mjs";

const repository = "example/project";
const apiBase = "https://api.github.com/repos/" + repository;
const githubUrl = "https://github.com/example/project/archive/refs/heads/main.zip";
const tagUrl = "https://github.com/example/project/archive/refs/tags/v1.2.3.zip";
const codeloadUrl = "https://codeload.github.com/example/project/legacy.zip/refs/heads/main";
const commitSha = "a".repeat(40);
const commitApi = apiBase + "/commits/main";
const tagCommitApi = apiBase + "/commits/v1.2.3";
const pinnedArchiveUrl = "https://github.com/" + repository + "/archive/" + commitSha + ".zip";
const pinnedCodeloadUrl = "https://codeload.github.com/" + repository + "/legacy.zip/" + commitSha;
const zipBytes = Buffer.from([80, 75, 3, 4, 102, 97, 107, 101]);
const commitResponse = (sha = commitSha) => new Response(JSON.stringify({ sha }), {
  status: 200, headers: { "content-type": "application/json" }
});

test("GitHub archive URL validator accepts branch, tag and pinned commit URLs only", () => {
  assert.deepEqual(
    (({ repository: repo, refType, ref }) => ({ repository: repo, refType, ref }))(validateGitHubArchiveUrl(githubUrl)),
    { repository, refType: "heads", ref: "main" }
  );
  assert.deepEqual(
    (({ repository: repo, refType, ref }) => ({ repository: repo, refType, ref }))(validateGitHubArchiveUrl(tagUrl)),
    { repository, refType: "tags", ref: "v1.2.3" }
  );
  assert.deepEqual(
    (({ repository: repo, refType, ref }) => ({ repository: repo, refType, ref }))(validateGitHubArchiveUrl(codeloadUrl)),
    { repository, refType: "heads", ref: "main" }
  );
  assert.deepEqual(
    (({ repository: repo, refType, ref }) => ({ repository: repo, refType, ref }))(validateGitHubArchiveUrl(pinnedArchiveUrl)),
    { repository, refType: "commit", ref: commitSha }
  );
  assert.deepEqual(
    (({ repository: repo, refType, ref }) => ({ repository: repo, refType, ref }))(validateGitHubArchiveUrl(pinnedCodeloadUrl)),
    { repository, refType: "commit", ref: commitSha }
  );
  for (const value of [
    "http://github.com/example/project/archive/refs/heads/main.zip",
    "https://evil.example/example/project/archive/refs/heads/main.zip",
    "https://github.com@example.com/example/project/archive/refs/heads/main.zip",
    "https://github.com/example/project/archive/refs/heads/main.zip?token=secret",
    "https://github.com/example/project/archive/refs/heads/main.zip#fragment",
    "https://github.com/example/project",
    "https://github.com/example/project/archive/../../secret.zip",
    "https://github.com/example/project/archive/not-a-commit.zip",
    "https://127.0.0.1/example/project/archive/refs/heads/main.zip"
  ]) assert.throws(() => validateGitHubArchiveUrl(value));
});

test("branch archive imports resolve to an immutable commit before downloading", async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url === commitApi) return commitResponse();
    if (url === pinnedArchiveUrl) return new Response(null, { status: 302, headers: { location: pinnedCodeloadUrl } });
    if (url === pinnedCodeloadUrl) return new Response(zipBytes, { status: 200, headers: { "content-length": String(zipBytes.length) } });
    throw new Error("unexpected URL: " + url);
  };
  const result = await fetchGitHubSkillArchive(githubUrl, { fetchImpl, maxBytes: 64 });
  assert.equal(result.repository, repository);
  assert.equal(result.sourceUrl, githubUrl);
  assert.equal(result.branch, "main");
  assert.equal(result.refType, "heads");
  assert.equal(result.commitSha, commitSha);
  assert.equal(result.resolvedFromRepository, false);
  assert.equal(result.redirects, 1);
  assert.equal(result.bytes, zipBytes.length);
  assert.deepEqual(calls, [commitApi, pinnedArchiveUrl, pinnedCodeloadUrl]);
});

test("tag archive imports resolve the tag to a commit SHA before downloading", async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url === tagCommitApi) return commitResponse();
    if (url === pinnedArchiveUrl) return new Response(null, { status: 302, headers: { location: pinnedCodeloadUrl } });
    if (url === pinnedCodeloadUrl) return new Response(zipBytes, { status: 200 });
    throw new Error("unexpected URL: " + url);
  };
  const result = await fetchGitHubSkillArchive(tagUrl, { fetchImpl, maxBytes: 64 });
  assert.equal(result.refType, "tags");
  assert.equal(result.branch, "v1.2.3");
  assert.equal(result.commitSha, commitSha);
  assert.deepEqual(calls, [tagCommitApi, pinnedArchiveUrl, pinnedCodeloadUrl]);
});

test("redirect validation blocks destinations outside the GitHub archive allowlist after pinning", async () => {
  await assert.rejects(
    fetchGitHubSkillArchive(githubUrl, {
      fetchImpl: async url => {
        if (url === commitApi) return commitResponse();
        if (url === pinnedArchiveUrl) return new Response(null, {
          status: 302, headers: { location: "http://127.0.0.1:18787/private" }
        });
        throw new Error("unexpected URL");
      }
    }),
    error => error.statusCode === 502 && error.code === "SKILL_REMOTE_REDIRECT_INVALID"
  );
});

test("remote import rejects declared and streamed archives larger than its limit", async () => {
  const respond = async (_url, declared) => new Response("12345", {
    status: 200, ...(declared ? { headers: { "content-length": "5" } } : {})
  });
  const makeFetch = declared => async url => {
    if (url === commitApi) return commitResponse();
    if (url === pinnedArchiveUrl) return respond(url, declared);
    throw new Error("unexpected URL");
  };
  await assert.rejects(
    fetchGitHubSkillArchive(githubUrl, { maxBytes: 4, fetchImpl: makeFetch(true) }),
    error => error.statusCode === 413 && error.code === "SKILL_REMOTE_TOO_LARGE"
  );
  await assert.rejects(
    fetchGitHubSkillArchive(githubUrl, { maxBytes: 4, fetchImpl: makeFetch(false) }),
    error => error.statusCode === 413 && error.code === "SKILL_REMOTE_TOO_LARGE"
  );
});

test("remote import rejects failed or empty archive responses without leaking response bodies", async () => {
  await assert.rejects(
    fetchGitHubSkillArchive(githubUrl, {
      fetchImpl: async url => {
        if (url === commitApi) return commitResponse();
        if (url === pinnedArchiveUrl) return new Response("private upstream diagnostic", { status: 403 });
        throw new Error("unexpected URL");
      }
    }),
    error => error.code === "SKILL_REMOTE_HTTP_FAILED" && !error.message.includes("private upstream diagnostic")
  );
  await assert.rejects(
    fetchGitHubSkillArchive(githubUrl, {
      fetchImpl: async url => {
        if (url === commitApi) return commitResponse();
        if (url === pinnedArchiveUrl) return new Response(null, { status: 200 });
        throw new Error("unexpected URL");
      }
    }),
    error => error.code === "SKILL_REMOTE_EMPTY"
  );
});

test("remote Skill import remains authenticated, rate-limited, and quarantine-only in the API and UI", async () => {
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
  assert.match(route, /archive\.commitSha/);
  assert.match(route, /commitSha: archive\.commitSha/);
  assert.match(route, /no extraction or execution occurred/);
  assert.match(html, /id="skill-remote-import-form"/);
  assert.match(html, /id="skill-remote-url" type="url" maxlength="2048"/);
  assert.match(html, /api\("\/api\/skills\/import-remote"/);
  assert.match(html, /result\.commitSha\?." commit /);
  assert.match(html, /尚未解压或执行/);
});

test("plain repository URLs resolve the default branch and also download by immutable commit SHA", async () => {
  const repoUrl = "https://github.com/example/project";
  const metadataUrl = "https://api.github.com/repos/example/project";
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url === metadataUrl) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    if (url === commitApi) return commitResponse();
    if (url === pinnedArchiveUrl) return new Response(null, { status: 302, headers: { location: pinnedCodeloadUrl } });
    if (url === pinnedCodeloadUrl) return new Response(zipBytes, { status: 200 });
    throw new Error("unexpected URL: " + url);
  };
  const result = await fetchGitHubSkillArchive(repoUrl, { fetchImpl, maxBytes: 64 });
  assert.equal(result.repository, repository);
  assert.equal(result.sourceUrl, repoUrl);
  assert.equal(result.branch, "main");
  assert.equal(result.refType, "heads");
  assert.equal(result.commitSha, commitSha);
  assert.equal(result.resolvedFromRepository, true);
  assert.equal(result.bytes, zipBytes.length);
  assert.deepEqual(calls, [metadataUrl, commitApi, pinnedArchiveUrl, pinnedCodeloadUrl]);
});

test("repository shortcut rejects unsafe default branch metadata before commit lookup", async () => {
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

test("GitHub metadata and ref errors never expose upstream response bodies", async () => {
  await assert.rejects(
    fetchGitHubSkillArchive("https://github.com/example/project", {
      fetchImpl: async () => new Response("private upstream secret", { status: 403 })
    }),
    error => error.code === "SKILL_REMOTE_LOOKUP_FAILED" && !error.message.includes("private upstream secret")
  );
  await assert.rejects(
    fetchGitHubSkillArchive(githubUrl, {
      fetchImpl: async () => new Response("private upstream secret", { status: 403 })
    }),
    error => error.code === "SKILL_REMOTE_COMMIT_LOOKUP_FAILED" && !error.message.includes("private upstream secret")
  );
});

test("invalid commit metadata is rejected and imported archive identity cannot float with a branch", async () => {
  let calls = 0;
  await assert.rejects(
    fetchGitHubSkillArchive(githubUrl, {
      fetchImpl: async url => {
        calls++;
        if (url === commitApi) return new Response(JSON.stringify({ sha: "not-a-commit" }), { status: 200 });
        throw new Error("archive download must not start before the SHA has been validated");
      }
    }),
    error => error.code === "SKILL_REMOTE_COMMIT_INVALID"
  );
  assert.equal(calls, 1);
});

test("explicit SHA archive URLs are already pinned and do not require another ref lookup", async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url === pinnedArchiveUrl) return new Response(null, { status: 302, headers: { location: pinnedCodeloadUrl } });
    if (url === pinnedCodeloadUrl) return new Response(zipBytes, { status: 200 });
    throw new Error("unexpected URL: " + url);
  };
  const result = await fetchGitHubSkillArchive(pinnedArchiveUrl, { fetchImpl, maxBytes: 64 });
  assert.equal(result.refType, "commit");
  assert.equal(result.branch, null);
  assert.equal(result.commitSha, commitSha);
  assert.deepEqual(calls, [pinnedArchiveUrl, pinnedCodeloadUrl]);
});

test("source provenance records the immutable SHA and UI displays the abbreviated commit", async () => {
  const server = await readFile(new URL("../apps/fnos-nas-agent/app/server.mjs", import.meta.url), "utf8");
  const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");
  const routeStart = server.indexOf('if (url.pathname === "/api/skills/import-remote")');
  const routeEnd = server.indexOf('if (url.pathname === "/api/skills/transitions/batch")', routeStart);
  const route = server.slice(routeStart, routeEnd);
  assert.match(route, /archive\.commitSha/);
  assert.match(route, /commitSha: archive\.commitSha/);
  assert.match(route, /sourcePrefix\.slice/);
  assert.match(route, /\+"#"\+archive\.commitSha/);
  assert.match(html, /result\.commitSha\.slice\(0,12\)/);
});

test("direct repository URL validator rejects non-root paths and other hosts", () => {
  assert.throws(() => validateGitHubRepositoryUrl("https://github.com/example/project/tree/main"));
  assert.throws(() => validateGitHubRepositoryUrl("https://github.com.example/owner/repo"));
});

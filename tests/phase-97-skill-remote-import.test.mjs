import test from "node:test";
import assert from "node:assert/strict";
import { fetchGitHubSkillArchive, validateGitHubArchiveUrl } from "../apps/fnos-nas-agent/app/skill-remote-import.mjs";

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
    return new Response(Buffer.from("PK\\x03\\x04fake"), { status: 200, headers: { "content-length": "8" } });
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

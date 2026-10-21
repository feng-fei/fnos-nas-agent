import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const script = new URL("../scripts/create-release-manifest.mjs", import.meta.url);

test("release manifest records artifact checksum and safe provenance fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-release-manifest-"));
  try {
    const artifact = join(dir, "sample.fpk");
    const output = join(dir, "manifest.json");
    const bytes = Buffer.from("test-fpk-payload");
    await writeFile(artifact, bytes);
    const result = spawnSync(process.execPath, [script.pathname, artifact, output], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_REPOSITORY: "owner/repo", GITHUB_SHA: "abc123", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ID: "12345" }
    });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(output, "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.artifact.fileName, "sample.fpk");
    assert.equal(manifest.artifact.sizeBytes, bytes.length);
    assert.equal(manifest.artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(manifest.source.repository, "owner/repo");
    assert.equal(manifest.source.commit, "abc123");
    assert.equal(manifest.source.runId, "12345");
    assert.equal(manifest.build.nodeVersion, process.version);
    assert.equal(manifest.verification.signature, "not-provided");
    assert.equal("artifactPath" in manifest, false);
    assert.equal("environment" in manifest, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release manifest refuses to overwrite an existing output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-release-manifest-"));
  try {
    const artifact = join(dir, "sample.fpk");
    const output = join(dir, "manifest.json");
    await writeFile(artifact, "payload");
    await writeFile(output, "{}\n");
    const result = spawnSync(process.execPath, [script.pathname, artifact, output], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(output, "utf8"), "{}\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

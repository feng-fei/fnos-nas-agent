import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const generator = new URL("../scripts/create-release-manifest.mjs", import.meta.url);
const verifier = new URL("../scripts/verify-release-artifact.mjs", import.meta.url);

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "fnos-release-verify-"));
  const artifact = join(dir, "sample.fpk");
  const checksum = join(dir, "sample.fpk.sha256");
  const manifest = join(dir, "release-manifest.json");
  const bytes = Buffer.from("sample-fpk-bytes");
  await writeFile(artifact, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(checksum, `${digest}  ${artifact}\n`);
  const generated = spawnSync(process.execPath, [generator.pathname, artifact, manifest], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  return { dir, artifact, checksum, manifest, bytes, digest };
}

function verify(f) {
  return spawnSync(process.execPath, [verifier.pathname, f.artifact, f.checksum, f.manifest], { encoding: "utf8" });
}

test("release verifier accepts matching FPK, sha256sum file, and manifest", async () => {
  const f = await fixture();
  try {
    const result = verify(f);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Release artifact verified/);
    assert.match(result.stdout, /does not verify publisher identity/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("release verifier rejects an artifact changed after manifest creation", async () => {
  const f = await fixture();
  try {
    await writeFile(f.artifact, Buffer.concat([f.bytes, Buffer.from("-tampered")]));
    const result = verify(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA-256 file does not match/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("release verifier rejects a manifest with an incorrect size", async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(f.manifest, "utf8"));
    manifest.artifact.sizeBytes += 1;
    await writeFile(f.manifest, JSON.stringify(manifest));
    const result = verify(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest size does not match/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("release verifier rejects a checksum naming a different artifact", async () => {
  const f = await fixture();
  try {
    await writeFile(f.checksum, `${f.digest}  other.fpk\n`);
    const result = verify(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum filename does not match/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

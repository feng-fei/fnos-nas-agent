import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function fixture(root, includeMain = true) {
  await mkdir(join(root, "cmd"), { recursive: true });
  await writeFile(join(root, "manifest"), "appname = fnos-nas-agent\n");
  await writeFile(join(root, "app.tgz"), "placeholder payload");
  if (includeMain) await writeFile(join(root, "cmd/main"), "#!/bin/sh\nexit 0\n");
}
function archive(root, output) {
  return spawnSync("tar", ["-czf", output, "-C", root, "manifest", "app.tgz", "cmd"], { encoding: "utf8" });
}
test("artifact verifier accepts required FPK structure", async () => {
  const root = await mkdtemp(join(tmpdir(), "fnos-fpk-valid-"));
  try {
    const source = join(root, "src"), artifact = join(root, "test.fpk");
    await mkdir(source); await fixture(source);
    const packed = archive(source, artifact);
    assert.equal(packed.status, 0, packed.stderr);
    const result = spawnSync(process.execPath, ["scripts/verify-fpk-artifact.mjs", artifact], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /FPK structure verified/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("artifact verifier rejects missing required entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "fnos-fpk-invalid-"));
  try {
    const source = join(root, "src"), artifact = join(root, "test.fpk");
    await mkdir(source); await fixture(source, false);
    const packed = archive(source, artifact);
    assert.equal(packed.status, 0, packed.stderr);
    const result = spawnSync(process.execPath, ["scripts/verify-fpk-artifact.mjs", artifact], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Required FPK entry missing: cmd\/main/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("artifact verifier rejects missing argument", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-fpk-artifact.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 2);
});

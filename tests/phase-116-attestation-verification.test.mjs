import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("main FPK attestation is cryptographically verified against expected provenance identity", async () => {
  const workflow = await readFile(".github/workflows/build-fpk.yml", "utf8");
  const attestJob = workflow.split("\n  attest:\n")[1] || "";
  assert.ok(attestJob.length > 0, "attestation job must exist");

  const signAt = attestJob.indexOf("uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6");
  const verifyAt = attestJob.indexOf("Verify generated provenance attestation");
  assert.ok(signAt >= 0 && verifyAt > signAt, "verification must run after signing");

  const verificationStep = attestJob.slice(verifyAt);
  assert.match(verificationStep, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(verificationStep, /gh attestation verify/);
  assert.match(verificationStep, /--repo feng-fei\/fnos-nas-agent/);
  assert.match(verificationStep, /--signer-workflow feng-fei\/fnos-nas-agent\/\.github\/workflows\/build-fpk\.yml/);
  assert.match(verificationStep, /--source-ref refs\/heads\/main/);
  assert.match(verificationStep, /artifact\/fnos-nas-agent-test-node-26\.fpk/);
});

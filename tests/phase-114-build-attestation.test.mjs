import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("FPK provenance attestation is limited to verified main-branch builds", async () => {
  const workflow = await readFile(".github/workflows/build-fpk.yml", "utf8");
  const buildJob = workflow.split("\n  attest:\n")[0] || "";
  const attestJob = workflow.split("\n  attest:\n")[1] || "";

  assert.match(workflow, /\n  push:\n    branches:\n      - main\n/);
  assert.match(attestJob, /if: github\.ref == 'refs\/heads\/main' && github\.event_name != 'pull_request'/);
  assert.match(attestJob, /needs: build/);
  assert.match(attestJob, /uses: actions\/download-artifact@v4/);
  assert.match(attestJob, /name: fnos-nas-agent-test-fpk-node-26\.x/);
  assert.match(attestJob, /Verify artifact bundle before attestation/);
  assert.match(attestJob, /node scripts\/verify-release-artifact\.mjs/);
  assert.match(attestJob, /uses: actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4\.2\.2/);
  assert.match(attestJob, /subject-path: artifact\/fnos-nas-agent-test-node-26\.fpk/);

  for (const permission of ["id-token: write", "attestations: write", "artifact-metadata: write"]) {
    assert.ok(attestJob.includes(permission), "attestation job must declare " + permission);
    assert.ok(!buildJob.includes(permission), "build job must not declare " + permission);
  }

  const verificationIndex = attestJob.indexOf("Verify artifact bundle before attestation");
  const attestationIndex = attestJob.indexOf("uses: actions/attest@v4");
  assert.ok(verificationIndex >= 0 && attestationIndex > verificationIndex,
    "artifact consistency must be re-verified before attestation");
});

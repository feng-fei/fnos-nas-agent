import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("CI uses Node 26 and builds a verified FPK test artifact", async () => {
  const workflow = await readFile(".github/workflows/build-fpk.yml", "utf8");
  assert.match(workflow, /node-version:\s*\["26\.x"\]/);
  assert.doesNotMatch(workflow, /node-version:\s*\["24\.x",\s*"26\.x"\]/);
  assert.match(workflow, /- name: Build FPK/);
  assert.match(workflow, /- name: Inspect package and checksum/);
  assert.match(workflow, /fnpack-1\.2\.3-linux-amd64/);
  assert.match(workflow, /sha256sum --check/);
  assert.match(workflow, /verify-fpk-artifact\.mjs/);
  assert.match(workflow, /create-release-manifest\.mjs/);
  assert.match(workflow, /verify-release-artifact\.mjs/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /  attest:/);
  assert.match(workflow, /uses: actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4\.2\.2/);
  assert.match(workflow, /Verify artifact bundle before attestation/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main' && github\.event_name != 'pull_request'/);
  assert.doesNotMatch(workflow, /actions\/attest-build-provenance@v2/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /Validate app scripts and entry syntax/);
});

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
  assert.doesNotMatch(workflow, /actions\/attest-build-provenance@v2/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /Validate app scripts and entry syntax/);
});

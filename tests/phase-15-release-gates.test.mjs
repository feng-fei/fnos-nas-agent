import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("fast CI uses Node 26 and keeps release packaging paused", async () => {
  const workflow = await readFile(".github/workflows/build-fpk.yml", "utf8");
  assert.match(workflow, /node-version:\s*\["26\.x"\]/);
  assert.doesNotMatch(workflow, /node-version:\s*\["24\.x",\s*"26\.x"\]/);
  assert.doesNotMatch(workflow, /- name: Build FPK/);
  assert.doesNotMatch(workflow, /- name: Inspect package and checksum/);
  assert.doesNotMatch(workflow, /actions\/attest-build-provenance@v2/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /Validate app scripts and entry syntax/);
});

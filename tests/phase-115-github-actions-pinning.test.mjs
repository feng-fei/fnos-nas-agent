import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("third-party GitHub Actions are pinned to verified immutable commit SHAs", async () => {
  const workflow = await readFile(".github/workflows/build-fpk.yml", "utf8");
  const pinned = [
    { action: "actions/checkout", sha: "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09", version: "v5.1.0", count: 2 },
    { action: "actions/setup-node", sha: "a0853c24544627f65ddf259abe73b1d18a591444", version: "v5.0.0", count: 2 },
    { action: "actions/upload-artifact", sha: "ea165f8d65b6e75b540449e92b4886f43607fa02", version: "v4.6.2", count: 1 },
    { action: "actions/download-artifact", sha: "d3f86a106a0bac45b974a628896c90dbdf5c8093", version: "v4.3.0", count: 1 },
    { action: "actions/attest", sha: "1e69f48acb82d1966a394da916b4c1698aa569d6", version: "v4.2.2", count: 1 }
  ];

  for (const pin of pinned) {
    assert.match(pin.sha, /^[a-f0-9]{40}$/);
    const line = "uses: " + pin.action + "@" + pin.sha + " # " + pin.version;
    assert.equal(workflow.split(line).length - 1, pin.count, line + " occurrence count");
  }

  assert.doesNotMatch(workflow,
    /uses:\s+actions\/(?:checkout|setup-node|upload-artifact|download-artifact|attest)@v\d/);
});

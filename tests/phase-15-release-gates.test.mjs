import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("release readiness gate script passes", () => {
  const result = spawnSync(process.execPath, ["scripts/check-release-gates.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Release readiness gates passed/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("expired-session persistence failures are handled and sanitized", async () => {
  const source = await readFile("apps/fnos-nas-agent/app/server.mjs", "utf8");
  assert.match(source, /if \(key && sessions\.delete\(key\)\) \{\s*void persistSessions\(\)\.catch\(\(\) => \{\s*console\.error\("Expired session cleanup could not be persisted\."\);\s*\}\);\s*\}/);
  assert.doesNotMatch(source, /if \(key && sessions\.delete\(key\)\) void persistSessions\(\);/);
  assert.doesNotMatch(source, /console\.error\([^)]*(?:error\.message|error\.stack|JSON\.stringify\(error)/);
});

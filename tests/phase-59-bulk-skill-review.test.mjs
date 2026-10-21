import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../apps/fnos-nas-agent/app/server.mjs", import.meta.url), "utf8");

test("bulk Skill review endpoint is authenticated, same-origin, bounded and reports per-item results", () => {
  const route = server.slice(server.indexOf('if (url.pathname === "/api/skills/transitions/batch")'),
    server.indexOf('const transitionMatch = url.pathname.match(/^\\/api\\/skills\\/([a-f0-9]{24})\\/transition$/);'));
  assert.match(route, /sessionFor\(req\)/);
  assert.match(route, /sameOrigin\(req\)/);
  assert.match(route, /items\.length < 1 \|\| body\.items\.length > 20/);
  assert.match(route, /Duplicate Skill IDs are not allowed/);
  assert.match(route, /await skillStore\.transition\(item\.id/);
  assert.match(route, /succeeded: results\.filter\(item => item\.ok\)\.length/);
  assert.match(route, /failed: results\.filter\(item => !item\.ok\)\.length/);
  assert.match(route, /Unable to update Skill state/);
});

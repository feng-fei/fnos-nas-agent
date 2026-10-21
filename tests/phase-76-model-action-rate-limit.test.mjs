import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../apps/fnos-nas-agent/app/server.mjs", import.meta.url), "utf8");

test("model catalog and connection-test actions share a per-session fixed-window limiter", () => {
  assert.match(server, /const modelActionLimiter = createFixedWindowLimiter\(\{ limit: 10, windowMs: 60_000, maxKeys: 1000 \}\)/);
  assert.match(server, /if \(!modelActionLimiter\.allow\(activeSession\.key\)\) return reply\(res, 429/);
  assert.match(server, /modelActionMatch\[2\] === "test" && !modelActionLimiter\.allow\(activeSession\.key\)/);
  assert.match(server, /"retry-after": "60"/);
});

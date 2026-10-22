import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("batch file operation API requires session, same-origin POST and JSON", async () => {
  const server = await readFile(new URL("../apps/fnos-nas-agent/app/server.mjs", import.meta.url), "utf8");
  const start = server.indexOf('if (url.pathname === "/api/files/operations/batch")');
  assert.notEqual(start, -1);
  const end = server.indexOf('\n    if (', start + 10);
  const route = server.slice(start, end === -1 ? undefined : end);
  assert.match(route, /req\.method !== "POST"/);
  assert.match(route, /sessionFor\(req\)/);
  assert.match(route, /sameOrigin\(req\)/);
  assert.match(route, /application\/json/);
  assert.match(route, /fileManager\.operateBatch\(body\)/);
  assert.match(route, /\[400,413\]/);
  // Destructive entries never run inside a batch: they are refused so the caller has to
  // request them one at a time through /api/files/operation and the approval flow.
  assert.match(route, /Destructive actions must be confirmed one at a time/);
  assert.match(route, /409/);
  // A batch that carries a write entry still has to pass the execution policy.
  assert.match(route, /executionPolicy\.evaluate\(\{ risk: "write", approved: false \}\)/);
});

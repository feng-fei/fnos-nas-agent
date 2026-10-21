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
  assert.match(route, /fileManager\.operateBatch\(await jsonBody\(req\)\)/);
  assert.match(route, /\[400,413\]/);
});

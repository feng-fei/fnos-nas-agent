import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../apps/fnos-nas-agent/app/server.mjs", import.meta.url), "utf8");

test("task history API validates status and pagination and returns bounded query metadata", () => {
  assert.match(server, /const requestedOffset = Number\(url\.searchParams\.get\("offset"\) \|\| 0\)/);
  assert.match(server, /const status = url\.searchParams\.get\("status"\) \|\| undefined/);
  assert.match(server, /Invalid task status filter/);
  assert.match(server, /Invalid task pagination/);
  assert.match(server, /taskManager\.query\(/);
  assert.match(server, /offset: Math\.trunc\(requestedOffset\), status/);
});

test("task history API validates bounded metadata search and passes it to the task manager", () => {
  assert.ok(server.includes('const search = url.searchParams.get("q") || undefined'));
  assert.ok(server.includes("search.length > 100"));
  assert.ok(server.includes("Invalid task search query"));
  assert.ok(server.includes("offset: Math.trunc(requestedOffset), status, search"));
});

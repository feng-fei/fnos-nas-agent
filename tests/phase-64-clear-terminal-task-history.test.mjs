import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../apps/fnos-nas-agent/app/server.mjs", import.meta.url), "utf8");
const audit = await readFile(new URL("../apps/fnos-nas-agent/app/audit-log.mjs", import.meta.url), "utf8");

test("task history cleanup is POST-only, authenticated, same-origin and audited", () => {
  const start = server.indexOf('if (url.pathname === "/api/tasks/clear-history")');
  const end = server.indexOf('if (url.pathname === "/api/tasks/status")', start);
  const route = server.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(route, /req\.method !== "POST"/);
  assert.match(route, /sessionFor\(req\)/);
  assert.match(route, /sameOrigin\(req\)/);
  assert.match(route, /taskManager\.clearTerminal\(\)/);
  assert.match(server, /pathname === "\/api\/tasks\/clear-history"\) return "tasks\.clear"/);
  assert.match(audit, /"tasks\.clear"/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");
const server = await readFile(new URL("../apps/fnos-nas-agent/app/server.mjs", import.meta.url), "utf8");

test("audit history API supports bounded outcome/route filters and pagination", () => {
  assert.match(server, /Invalid audit pagination/);
  assert.match(server, /Invalid audit outcome filter/);
  assert.match(server, /Invalid audit route filter/);
  assert.match(server, /allEvents\.slice\(requestedOffset, requestedOffset \+ limit\)/);
  assert.match(server, /total: allEvents\.length, limit, offset: requestedOffset/);
});

test("mobile audit viewer exposes result filtering, route filtering and page controls", () => {
  assert.match(html, /id="audit-outcome"/);
  assert.match(html, /id="audit-route"/);
  assert.match(html, /id="audit-apply"/);
  assert.match(html, /id="audit-count"/);
  assert.match(html, /id="audit-prev"/);
  assert.match(html, /id="audit-next"/);
  assert.match(html, /params\.set\("outcome",outcome\)/);
  assert.match(html, /params\.set\("route",route\)/);
  assert.match(html, /api\("\/api\/audit\?"/);
});

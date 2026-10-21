import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");
const server = await readFile(new URL("../apps/fnos-nas-agent/app/server.mjs", import.meta.url), "utf8");

test("file API validates bounded offsets and returns page metadata", () => {
  assert.match(server, /Invalid directory pagination offset/);
  assert.match(server, /fileBrowser\.list\(url\.searchParams\.get\("path"\) \|\| "", rawLimit, rawOffset\)/);
});

test("mobile file browser has previous/next page controls", () => {
  assert.match(html, /id="file-page-info"/);
  assert.match(html, /id="file-page-prev"/);
  assert.match(html, /id="file-page-next"/);
  assert.match(html, /currentFileOffset\+100/);
  assert.match(html, /currentFileOffset-100/);
  assert.match(html, /data\.totalEntries/);
});

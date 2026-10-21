import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Skill manager supports sequential multi-archive import with aggregate progress", async () => {
  const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");
  assert.match(html, /id="skill-archive"[^>]*multiple/);
  assert.match(html, /Array\.from\(document\.querySelector\("#skill-archive"\)\.files/);
  assert.match(html, /for\(let index=0;index<files\.length;index\+\+\)/);
  assert.match(html, /Math\.round\(\(\(index\+percent\/100\)\/files\.length\)\*100\)/);
  assert.match(html, /超过 25 MiB，未开始上传/);
  assert.match(html, /此前已成功隔离/);
  assert.match(html, /均未解压或执行/);
});

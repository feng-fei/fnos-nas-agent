import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("mobile file browser supports sequential multi-file upload with aggregate progress and cancellation", async () => {
  const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");
  assert.match(html, /id="file-upload"[^>]*multiple/);
  assert.match(html, /Array\.from\(field\.files\|\|\[\]\)/);
  assert.match(html, /files\.length>20/);
  assert.match(html, /files\.find\(file=>file\.size>25\*1024\*1024\)/);
  assert.match(html, /for\(let index=0;index<files\.length;index\+\+\)/);
  assert.match(html, /Math\.round\(\(\(index\+percent\/100\)\/files\.length\)\*100\)/);
  assert.match(html, /此前已成功上传/);
  assert.match(html, /上传请求已中止/);
});

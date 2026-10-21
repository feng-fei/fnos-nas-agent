import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");

test("mobile file uploads show bounded progress and retain existing upload limits", () => {
  assert.match(html, /id="file-upload-progress"/);
  assert.match(html, /id="file-upload-status"/);
  assert.match(html, /xhr\.upload\.addEventListener\("progress"/);
  assert.match(html, /xhr\.withCredentials=true/);
  assert.match(html, /content-type","application\/octet-stream"/);
  assert.match(html, /file\.size>25\*1024\*1024/);
  assert.match(html, /正在上传第 /);
  assert.match(html, /status\.textContent=.*上传/);
});

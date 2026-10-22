import test from "node:test";
import assert from "node:assert/strict";
import { readUiSource } from "./helpers/ui-source.mjs";

const html = await readUiSource();

test("mobile file uploads show bounded progress and retain existing upload limits", () => {
  assert.match(html, /id="file-upload-progress"/);
  assert.match(html, /id="file-upload-status"/);
  assert.match(html, /xhr\.upload\.addEventListener\("progress"/);
  assert.match(html, /xhr\.withCredentials=true/);
  assert.match(html, /content-type","application\/octet-stream"/);
  assert.match(html, /file\.size>25\*1024\*1024/);
  assert.match(html, /正在上传第 /);
  assert.match(html, /上传停止：已完成/);
});

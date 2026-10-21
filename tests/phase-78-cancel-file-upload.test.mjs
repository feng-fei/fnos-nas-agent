import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");

test("mobile upload can be aborted and then reconciles directory state", () => {
  assert.match(html, /id="file-upload-cancel"/);
  assert.match(html, /activeUploadXhr\.abort\(\)/);
  assert.match(html, /xhr\.addEventListener\("abort"/);
  assert.match(html, /已发送取消请求，正在刷新目录确认文件状态/);
  assert.match(html, /上传请求已中止；请检查目录确认文件是否存在/);
  assert.match(html, /cancel\.disabled=true/);
});

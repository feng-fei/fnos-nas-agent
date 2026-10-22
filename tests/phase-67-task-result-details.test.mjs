import test from "node:test";
import assert from "node:assert/strict";
import { readUiSource } from "./helpers/ui-source.mjs";

const html = await readUiSource();

test("task history exposes bounded expandable execution results using textContent", () => {
  assert.match(html, /查看执行结果/);
  assert.match(html, /task\.result\.results\.slice\(0,10\)/);
  assert.match(html, /serialized\.length>12000/);
  assert.match(html, /pre\.textContent=serialized/);
  assert.match(html, /仅显示前 10 项/);
});

test("task result UI reports server-side truncation", () => {
  assert.match(html, /task\.result\?\.truncated/);
  assert.match(html, /任务结果过大，已在服务端限制保留内容/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");

test("task history exposes bounded expandable execution results using textContent", () => {
  assert.match(html, /查看执行结果/);
  assert.match(html, /task\.result\.results\.slice\(0,10\)/);
  assert.match(html, /serialized\.length>12000/);
  assert.match(html, /pre\.textContent=serialized/);
  assert.match(html, /仅显示前 10 项/);
});

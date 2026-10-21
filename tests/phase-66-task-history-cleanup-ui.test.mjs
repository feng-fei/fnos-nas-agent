import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");

test("task history cleanup requires confirmation and warns that active tasks are preserved", () => {
  assert.match(html, /id="task-history-clear"/);
  assert.match(html, /清理已完成、失败和已取消的任务记录/);
  assert.match(html, /排队中和运行中的任务会保留，不会被取消/);
  assert.match(html, /api\("\/api\/tasks\/clear-history",\{method:"POST"\}\)/);
  assert.match(html, /已清理 .* 条已结束任务/);
});

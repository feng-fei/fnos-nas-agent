import test from "node:test";
import assert from "node:assert/strict";
import { readUiSource } from "./helpers/ui-source.mjs";

const html = await readUiSource();

test("task history cleanup requires confirmation and preserves active work", () => {
  assert.match(html, /id="task-history-clear"/);
  assert.match(html, /清理已完成、失败和已取消的任务记录/);
  assert.match(html, /排队中和运行中的任务会保留，不会被取消/);
  assert.match(html, /api\("\/api\/tasks\/clear-history",\{method:"POST"\}\)/);
  assert.match(html, /已清理 .* 条已结束任务/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");

test("mobile task history supports status filtering, pagination, and bounded server queries", () => {
  assert.match(html, /id="task-history-status"/);
  assert.match(html, /id="task-history-count"/);
  assert.match(html, /id="task-history-prev"/);
  assert.match(html, /id="task-history-next"/);
  assert.match(html, /taskHistoryPageSize=10/);
  assert.match(html, /params\.set\("status",status\)/);
  assert.match(html, /params=new URLSearchParams\(\{limit:String\(taskHistoryPageSize\),offset:String\(taskHistoryOffset\)\}\)/);
  assert.match(html, /取消排队任务/);
  assert.match(html, /task-history-next.*disabled=data\.offset\+data\.tasks\.length>=data\.total/s);
});

test("mobile task history searches task IDs and stages without sending task inputs", () => {
  assert.match(html, /id="task-history-search" type="search" maxlength="100"/);
  assert.match(html, /搜索任务 ID、状态或阶段/);
  assert.match(html, /params\.set\("q",search\)/);
  assert.match(html, /task-history-search.*refreshRecentTasks/s);
});

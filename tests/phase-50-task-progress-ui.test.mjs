import test from "node:test";
import assert from "node:assert/strict";
import { readUiSource } from "./helpers/ui-source.mjs";

test("mobile task history renders bounded progress and refreshes active tasks", async () => {
  const html = await readUiSource();
  assert.match(html, /task.progress/);
  assert.match(html, /<progress|createElement\("progress"\)/);
  assert.match(html, /setTimeout\(refreshRecentTasks,1200\)/);
  assert.match(html, /task.stage/);
  assert.match(html, /clearTimeout\(taskRefreshTimer\)/);
});

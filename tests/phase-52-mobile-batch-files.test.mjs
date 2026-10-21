import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("mobile file browser exposes bounded batch move and confirmed batch delete", async () => {
  const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");
  assert.match(html, /file-batch-move/);
  assert.match(html, /file-batch-delete/);
  assert.match(html, /selectedFileItems/);
  assert.match(html, /\/api\/files\/operations\/batch/);
  assert.match(html, /confirm:true/);
  assert.match(html, /data\.succeeded/);
  assert.match(html, /data\.failed/);
});

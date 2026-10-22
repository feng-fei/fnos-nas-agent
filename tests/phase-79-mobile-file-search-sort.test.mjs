import test from "node:test";
import assert from "node:assert/strict";
import { readUiSource } from "./helpers/ui-source.mjs";

test("mobile file browser exposes search, type filtering and bounded sort choices", async () => {
  const html = await readUiSource();
  assert.match(html, /id="file-search"[^>]*type="search"/);
  assert.match(html, /id="file-type-filter"/);
  assert.match(html, /<option value="directory">文件夹<\/option>/);
  assert.match(html, /<option value="file">文件<\/option>/);
  assert.match(html, /id="file-sort"/);
  assert.match(html, /value="name-asc"/);
  assert.match(html, /value="name-desc"/);
  assert.match(html, /value="size-desc"/);
  assert.match(html, /value="modified-desc"/);
  assert.match(html, /const visibleEntries=data\.entries\.filter/);
  assert.match(html, /visibleEntries\.sort/);
  assert.match(html, /fileSearchTimer=setTimeout\(\(\)=>refreshFiles\(currentFilePath\),180\)/);
  assert.match(html, /没有符合筛选条件的项目/);
});

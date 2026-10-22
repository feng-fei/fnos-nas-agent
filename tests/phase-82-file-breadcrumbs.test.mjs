import test from "node:test";
import assert from "node:assert/strict";
import { readUiSource } from "./helpers/ui-source.mjs";

test("mobile file browser builds clickable breadcrumbs only from configured roots", async () => {
  const html = await readUiSource();
  assert.match(html, /id="file-breadcrumbs"[^>]*aria-label="目录路径"/);
  assert.match(html, /const matchingRoot=\(data\.roots\|\|\[\]\)\.filter/);
  assert.match(html, /currentFilePath\.startsWith\(root\.path\.replace/);
  assert.match(html, /current\.setAttribute\("aria-current","location"\)/);
  assert.match(html, /button\.addEventListener\("click",\(\)=>refreshFiles\(crumb\.path\)\)/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("mobile file browser builds clickable breadcrumbs only from configured roots", async () => {
  const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");
  assert.match(html, /id="file-breadcrumbs"[^>]*aria-label="目录路径"/);
  assert.match(html, /const matchingRoot=\(data\.roots\|\|\[\]\)\.filter/);
  assert.match(html, /currentFilePath\.startsWith\(root\.path\.replace/);
  assert.match(html, /current\.setAttribute\("aria-current","location"\)/);
  assert.match(html, /button\.addEventListener\("click",\(\)=>refreshFiles\(crumb\.path\)\)/);
});

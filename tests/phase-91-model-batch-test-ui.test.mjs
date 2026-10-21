import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");

test("model provider UI supports sequential batches of at most five connection tests", () => {
  assert.match(html, /id="model-provider-test-batch"/);
  assert.match(html, /id="model-provider-test-batch-status"/);
  assert.match(html, /filter\(item=>item\.enabled&&item\.hasApiKey\)/);
  assert.match(html, /enabled\.slice\(start,start\+5\)/);
  assert.match(html, /for\(let index=0;index<batch\.length;index\+\+\)/);
  assert.match(html, /\/api\/models\/"\+encodeURIComponent\(item\.id\)\+"\/test/);
  assert.match(html, /modelBatchTestOffset=start\+batch\.length>=enabled\.length\?0:start\+batch\.length/);
  assert.match(html, /还有 "\+remaining\+" 个未测试/);
  assert.match(html, /button\.disabled=true/);
  assert.match(html, /finally\{button\.disabled=false;\}/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");

test("model provider cards and batch results display safe connection diagnostics", () => {
  assert.match(html, /Number\.isSafeInteger\(item\.lastTest\.durationMs\)/);
  assert.match(html, /耗时 "\+item\.lastTest\.durationMs\+" ms/);
  assert.match(html, /Number\.isInteger\(item\.lastTest\.statusCode\)/);
  assert.match(html, /HTTP "\+item\.lastTest\.statusCode/);
  assert.match(html, /durationMs:Number\.isSafeInteger\(payload\.test\?\.durationMs\)\?payload\.test\.durationMs:null/);
  assert.match(html, /Number\.isSafeInteger\(item\.durationMs\)/);
});

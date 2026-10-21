import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");

test("mobile Skill inventory supports visible-page selection and bounded bulk transitions", () => {
  assert.match(html, /id="skill-select-visible"/);
  assert.match(html, /id="skill-batch-state"/);
  assert.match(html, /id="skill-batch-note"/);
  assert.match(html, /id="skill-batch-apply"/);
  assert.match(html, /id="skill-selected-count"/);
  assert.match(html, /selectedSkillIds=new Set\(\)/);
  assert.match(html, /\/api\/skills\/transitions\/batch/);
  assert.match(html, /items:ids\.map\(id=>\(\{id,state,note:/);
  assert.match(html, /失败项仍保留选择/);
  assert.match(html, /批量拒绝所选 Skill/);
});

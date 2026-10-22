import test from "node:test";
import assert from "node:assert/strict";
import { readUiSource } from "./helpers/ui-source.mjs";

const html = await readUiSource();

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

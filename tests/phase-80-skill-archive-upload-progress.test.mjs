import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Skill ZIP upload exposes progress and abort controls without changing quarantine semantics", async () => {
  const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");
  assert.match(html, /id="skill-import-progress"[^>]*max="100"/);
  assert.match(html, /id="skill-import-status"/);
  assert.match(html, /id="skill-import-cancel"[^>]*disabled/);
  assert.match(html, /function uploadSkillArchive\(/);
  assert.match(html, /xhr\.upload\.addEventListener\("progress"/);
  assert.match(html, /xhr\.addEventListener\("abort"/);
  assert.match(html, /activeSkillUploadXhr\.abort\(\)/);
  assert.match(html, /尚未解压或执行/);
  assert.match(html, /file\.size>25\*1024\*1024/);
});

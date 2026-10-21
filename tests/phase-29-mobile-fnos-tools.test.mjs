import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");

test("mobile read-only tool panel builds inputs from each tool schema", () => {
  assert.match(html, /const schema=item\.inputSchema\|\|\{\},properties=schema\.properties\|\|\{\}/);
  assert.match(html, /input\.required=\(schema\.required\|\|\[\]\)\.includes\(name\)/);
  assert.match(html, /rule\.type==="integer"\?"number":"text"/);
  assert.match(html, /rule\.minimum!==undefined\)input\.min=String\(rule\.minimum\)/);
  assert.match(html, /rule\.maximum!==undefined\)input\.max=String\(rule\.maximum\)/);
});

test("mobile read-only tool panel submits typed arguments instead of always sending an empty object", () => {
  assert.match(html, /args\[name\]=rule\.type==="integer"\?Number\(field\.value\):field\.value/);
  assert.match(html, /body:JSON\.stringify\(args\)/);
  assert.doesNotMatch(html, /body:"\{\}"\}\);const payload=await result\.json\(\)/);
});

test("Agent status tells the user whether optional official trim-cli is ready", () => {
  assert.match(html, /官方 fnOS CLI 已安装且可执行；OAuth\/连接状态尚未验证/);
  assert.match(html, /官方 fnOS CLI 路径已配置但不可执行/);
  assert.match(html, /官方 fnOS CLI 尚未安装/);
  assert.match(html, /CLI 可执行不代表 OAuth 已授权/);
  assert.match(html, /\/api\/agent\/trim-cli\/test/);
});

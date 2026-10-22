import test from "node:test";
import assert from "node:assert/strict";
import { readUiSource } from "./helpers/ui-source.mjs";

const html = await readUiSource();

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
  assert.match(html, /CLI 已安装且可执行/);
  assert.match(html, /CLI 路径已配置但不可执行/);
  assert.match(html, /官方 CLI 尚未安装/);
  assert.match(html, /连接状态：/);
  assert.match(html, /需要重新登录/);
  assert.match(html, /授权范围不足/);
  assert.match(html, /CLI 可执行不代表 OAuth 已授权/);
  assert.match(html, /\/api\/agent\/trim-cli\/test/);
});

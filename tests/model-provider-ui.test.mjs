import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");

test("model provider manager provides add/edit fields and stores API keys only in a password input", () => {
  assert.match(html, /id="models-card"/);
  assert.match(html, /id="model-provider-form"/);
  assert.match(html, /id="model-provider-name"/);
  assert.match(html, /id="model-provider-endpoint"/);
  assert.match(html, /id="model-provider-model"/);
  assert.match(html, /id="model-provider-key" type="password"/);
  assert.match(html, /id="model-provider-enabled"/);
  assert.match(html, /id="model-provider-clear-key"/);
  assert.match(html, /id="model-provider-list"/);
  assert.match(html, /autocomplete="new-password" placeholder="添加时必填；编辑时留空表示保留已保存密钥"/);
});

test("model UI calls authenticated CRUD, connection test and active-provider endpoints", () => {
  assert.match(html, /api\("\/api\/models"/);
  assert.match(html, /method:id\?"PUT":"POST"/);
  assert.match(html, /method:"DELETE"/);
  assert.match(html, /\/default/);
  assert.match(html, /\/test/);
  assert.match(html, /已加密保存/);
  assert.match(html, /设为默认/);
  assert.match(html, /测试连接/);
  assert.match(html, /清除已保存的 API Key/);
});

test("provider UI uses textContent for provider metadata and never renders a key value", () => {
  assert.match(html, /heading\.textContent=item\.name/);
  assert.match(html, /meta\.textContent="模型："/);
  assert.match(html, /item\.hasApiKey\?"已加密保存":"未配置"/);
  assert.doesNotMatch(html, /item\.apiKey/);
  assert.doesNotMatch(html, /apiKeyEncrypted/);
});

test("logged-in sessions reveal model management and reload the active model state", () => {
  assert.match(html, /#models-card"\)\.classList\.remove\("hidden"\)/);
  assert.match(html, /await refreshModels\(\)/);
  assert.match(html, /当前默认模型：/);
});

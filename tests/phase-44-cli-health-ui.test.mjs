import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");

test("connection status distinguishes auth, scope, network, TLS, timeout and stale states", () => {
  for (const label of [
    "需要重新登录", "授权范围不足", "HTTPS 证书错误", "请求超时",
    "网络不可达", "请求过于频繁", "Profile 配置不可用", "检测结果已过期", "连接正常"
  ]) assert.ok(html.includes(label), "missing status label: " + label);
  assert.match(html, /trim-cli-connection-detail/);
  assert.match(html, /cli\.errorCategory/);
  assert.match(html, /cli\.nextAction/);
  assert.match(html, /上次检测：/);
});

test("CLI tool errors render next actions and refresh the current connection state", () => {
  assert.match(html, /payload\.nextAction/);
  assert.match(html, /item\.providerAvailable===false/);
  assert.match(html, /先安装官方 CLI/);
  assert.match(html, /await refreshAgentStatus\(\)/);
  assert.match(html, /建议：/);
});

test("the UI provides a refresh-authorization path but never captures an OAuth token or code", () => {
  assert.match(html, /重新授权（login --refresh）/);
  assert.match(html, /一次性 code 直接粘贴到 CLI 的交互提示符/);
  assert.doesNotMatch(html, /id="(?:oauth-code|authorization-code|access-token|refresh-token)"/);
});

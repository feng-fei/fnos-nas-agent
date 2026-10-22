import test from "node:test";
import assert from "node:assert/strict";
import { readUiSource } from "./helpers/ui-source.mjs";

const html = await readUiSource();

test("mobile OAuth setup generates a server-validated command without accepting a code or token", () => {
  assert.match(html, /\/api\/agent\/trim-cli\/login-command/);
  assert.match(html, /id="trim-cli-host"/);
  assert.match(html, /id="trim-cli-port"/);
  assert.match(html, /id="trim-cli-flow"/);
  assert.match(html, /id="trim-cli-self-signed"/);
  assert.match(html, /let generatedTrimCliCommand = ""/);
  assert.match(html, /CLI 输出授权链接后，在你自己的浏览器中登录并确认授权，再将一次性 code 直接粘贴到 CLI 的交互提示符/);
  assert.match(html, /本页面只生成命令，不会执行登录，不会接收验证码或令牌/);
  assert.doesNotMatch(html, /id="(?:oauth-code|authorization-code|access-token|refresh-token)"/);
});

test("OAuth setup explains that profile storage must match the running Agent account", () => {
  assert.match(html, /Agent 的运行账户/);
  assert.match(html, /Agent 私有数据目录/);
  assert.match(html, /不能改用其他账户保存 profile/);
  assert.match(html, /检测官方 CLI 连接/);
});

test("connection-check UI does not equate an installed CLI with an authenticated connection", () => {
  assert.match(html, /CLI 可执行不代表 OAuth 已授权/);
  assert.match(html, /\/api\/agent\/trim-cli\/test/);
  assert.match(html, /OAuth 授权与 API 连通性已验证/);
});

# Phase 218：模型 Endpoint 支持只填 base 地址

## 背景

在界面上添加模型供应商时，只要没把地址写到 `/chat/completions` 结尾就会被拒绝，报
`Endpoint must end with /chat/completions (such as /v1/chat/completions).`。
实际填写的人是照服务商文档抄的 base 地址（如 `https://api.deepseek.com/v1`），
他要的是「保存能对话的配置」，不是「背一条路径规则」。这条校验把一个可自动补齐的
细节变成了拦路的错误，属于本产品最该避免的那类摩擦。

## 改动

`apps/fnos-nas-agent/app/model-provider-store.mjs` 的 `endpoint()`：

1. 先做原有安全校验（HTTPS，或 localhost/127.0.0.1/[::1] 上的 HTTP；禁止 URL 里的
   账号密码、查询串、片段）。
2. 末尾斜杠归一后按三条规则补全路径：
   - 已以 `/chat/completions` 结尾：原样保留；
   - 以 `/chat` 结尾：补 `/completions`（不会叠成 `/chat/chat/completions`）；
   - 路径为空，或最后一段是 `v1` / `v1beta` / `v4` / `openai` / `compatible-mode` /
     `api` / `paas` 这类版本或入口段：补 `/chat/completions`。
3. 其余路径仍然拒绝，避免把 `/v1/responses`、`/v1/embeddings` 猜成 base 后拼出
   一个并不存在的地址。错误文案改为给出 base 地址示例。

因为对话通道的安全校验（`model-chat-adapter.mjs` 的 `safeChatEndpoint`）本来就复用
`validateModelProviderInput`，入库的地址一定是补全后的完整地址，取用侧不需要再改。

界面同步把输入框的提示从「完整地址」改成「可只填到 /v1，会自动补全」，
placeholder 换成 `https://api.deepseek.com/v1`。

## 兼容性

- 已保存的供应商记录都是完整地址，规则对它们是不动点，无需迁移。
- 只放宽了「路径必须写成什么样」，没有放宽协议、主机、凭据、查询串的限制；
  白名单语义完全不变。
- 预设（`model-provider-presets.mjs`）全部仍是完整地址，保持原样。

## 验证

- `tests/model-provider-store.test.mjs` 新增两组用例：base 补全（根地址、`/v1`、
  带尾斜杠、`compatible-mode/v1`、`paas/v4`、本机 Ollama base、`/chat` 续写、已完整
  地址不变）与继续拒绝的路径（`/v1/responses`、`/download`、`/v1/embeddings`、
  非 HTTPS 远端、带凭据、带查询串）。
- 相关套件：`model-provider-store`、`model-provider-api`、`phase-19`、`phase-72`、
  `phase-150`、`phase-154`、`phase-157`、`phase-174` 全部通过（Windows 上仅剩
  文件权限位相关的既有环境失败）。
- 真机：把该模块与界面文件同步到 NAS 的应用目录并重启服务后，用部署里的
  Node 直接调用 `validateModelProviderInput`，`https://api.deepseek.com/v1` 返回
  `https://api.deepseek.com/v1/chat/completions`，`/v1/responses` 仍被拒。

## 遗留

- 应用中心「重启」会用同样的入口脚本重新拉起进程；本次为了立刻可用，用一次性
  transient unit 拉起了同一份代码，用户在应用中心点一次「重启」即可回到应用中心托管。

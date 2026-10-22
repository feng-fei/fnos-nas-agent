# Phase 150 — 直聊通道（model-chat-adapter）

## 背景

现有适配层 `apps/fnos-nas-agent/app/model-adapter.mjs` 是**规划器**：它要求模型返回一份 JSON 计划
（`buildPlan()`，`model-adapter.mjs:123-148`），每次工具调用都必须通过注册工具目录的 `inputSchema` 校验。
这条契约是 agent 的安全边界，不能为了「聊天」而放松。

UI 侧要的「Marvis 式直聊」是**纯文本往返**：不需要计划、不需要工具、不需要 JSON。
因此本阶段新增一条**独立通道** `apps/fnos-nas-agent/app/model-chat-adapter.mjs`，
它只复用规划器的**传输层规则**（端点白名单、Bearer 密钥、有界响应体、错误码风格），
不复用 `plan()` 的 JSON 契约，也不改动 `plan()` / `buildPlan()` 的任何一行。

## 交付物

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `apps/fnos-nas-agent/app/model-chat-adapter.mjs` | 新建（290 行） | 直聊通道 `createModelChatAdapter()` |
| `apps/fnos-nas-agent/app/model-provider-store.mjs` | 改动 2 处 | `publicProvider()` `:65-78`、`normalizeProviderRecord()` `:108-127` |
| `tests/phase-150-model-chat-adapter.test.mjs` | 新建（285 行） | 18 个用例，零依赖（`node:test` + `node:assert/strict`） |
| `docs/phase-150-model-chat-adapter.md` | 新建 | 本文件 |

未改动：`server.mjs`、`docs/README.md`、任何 UI 文件、`model-adapter.mjs`、`plan()` 契约。

## 对外签名

```js
import { createModelChatAdapter } from "./model-chat-adapter.mjs";

const chatAdapter = createModelChatAdapter({ providerStore, fetchImpl = fetch, now = () => Date.now() });
// -> { chat, status }
```

- `providerStore`：必须暴露 `runtimeConfig()`（即 `model-provider-store.mjs` 的实例），
  返回 `{enabled, endpoint, apiKey, model, timeoutMs, providerId, providerName}` 或 `null`。
  读取失败（store 关闭、抛错）一律按「没有可用供应商」处理，不抛出。
- `fetchImpl` / `now`：与 `createModelAdapter()` 同样的注入风格，便于测试与计时。

### `chat({ messages, signal, onDelta })` → `Promise<string>`

- 返回**最终完整文本**（所有 delta 拼接结果）。
- `onDelta(textChunk)` 每收到一个 delta 调用一次，**可以是 async，会被 await**（保证按序推送，
  不会因为写入 SSE 比读取快而乱序）。
- `signal`：调用方取消信号；与内部 `AbortSignal.timeout(timeoutMs)` 通过 `AbortSignal.any` 合并。
- 不做任何重试、不做备用供应商降级：直聊是一次性请求，重试语义由调用方（UI）决定。

### `status()` → `{ enabled, providerConfigured, model, providerId, providerName }`

与 `model-adapter.mjs` 的 `modelStatus` 风格一致（`model-adapter.mjs:432-449`）：

| 字段 | 含义 |
| --- | --- |
| `providerConfigured` | 存在一个启用了、带密钥、填了模型名的供应商 |
| `enabled` | 上述供应商的 endpoint 也在安全白名单内（**能真的发起一轮对话**） |
| `model` / `providerId` / `providerName` | 无可用供应商时为 `null` |

## 请求契约

```
POST <provider.endpoint>
authorization: Bearer <apiKey>
content-type: application/json
accept: text/event-stream

{ "model": "<model>", "temperature": 0.2, "max_tokens": 1200, "stream": true,
  "messages": [ { "role": "user"|"assistant"|"system", "content": "..." } ] }
```

响应按 OpenAI SSE 解析：逐行读 `data: {...}`，`data: [DONE]` 结束流；
`choices[0].delta.content` 累积并回调 `onDelta`。
容错：注释行（`: keep-alive`）、空行忽略；`data:` 载荷不是合法 JSON → `MODEL_CHAT_INVALID_RESPONSE`；
上游在流里返回 `{"error": {...}}` → `MODEL_CHAT_UPSTREAM_ERROR`；
若服务商忽略 `stream:true` 直接返回完整 JSON，则回退读取 `choices[0].message.content`。

## 端点白名单（不复制一份新的校验）

白名单规则：**只允许 HTTPS，或 http + loopback（`localhost` / `127.0.0.1` / `[::1]`）；
禁止 userinfo / query / fragment；路径必须以 `/chat/completions` 结尾。**

实现方式：**调用现有的两处安全函数，而不是再写第三份**：

1. `model-adapter.mjs` 的 `safeEndpoint()`（`model-adapter.mjs:34-41`）——
   它是模块私有的，但 `modelConfiguration()` 是导出的，所以通过
   `modelConfiguration({AGENT_MODEL_ENABLED:"true", AGENT_MODEL_ENDPOINT: value, ...}).endpoint`
   走到同一份 `safeEndpoint()`，得到 HTTPS / loopback / 无 userinfo / 无 fragment 的判定。
2. `model-provider-store.mjs` 的 `endpoint()`（`model-provider-store.mjs:49-60`）——
   它同样是私有的，但 `validateModelProviderInput()` 是导出的，所以通过它拿到**规范化后的 endpoint**，
   同时拿到「禁止 query」与「路径必须以 `/chat/completions` 结尾」这两条更严的规则。

> 说明：`model-adapter.mjs` 与 `model-provider-store.mjs` 的**其它函数在本阶段不允许改动**，
> 因此没有把 `safeEndpoint()` / `endpoint()` 改成 `export`，而是走已有的导出入口复用它们。
> 若后续允许改动，正确的收敛方向是把两处白名单合并成一个共享模块并由三处共同引用。

违反白名单时抛 `MODEL_CHAT_INVALID_ENDPOINT`（`statusCode: 400`），**请求不会离开进程**。

## 入参校验（`messages`）

| 约束 | 值 | 违反时 |
| --- | --- | --- |
| 必须是数组 | — | `MODEL_CHAT_INVALID_REQUEST` 400 |
| 条数 | 1 ~ 32 | 同上 |
| `role` | `user` \| `assistant` \| `system` | 同上 |
| `content` | 字符串、非空白 | 同上 |
| `content` 长度 | ≤ 2000 字符 | 同上 |

校验失败发生在任何网络调用之前。

## 错误码清单

| code | statusCode | category | 触发条件 |
| --- | --- | --- | --- |
| `MODEL_CHAT_ABORTED` | 499 | `CANCELLED` | 调用方取消（发起前已取消，或流中被 abort） |
| `MODEL_CHAT_INVALID_REQUEST` | 400 | `INVALID_REQUEST` | `messages` 不合法 |
| `MODEL_CHAT_INVALID_ENDPOINT` | 400 | `INVALID_ENDPOINT` | endpoint 不在白名单内 |
| `MODEL_CHAT_NOT_CONFIGURED` | 502 | `NOT_CONFIGURED` | 没有启用且带密钥的供应商 |
| `MODEL_CHAT_UPSTREAM_ERROR` | 502 / 上游状态码 | `UPSTREAM_ERROR` / `RATE_LIMITED` / `PROVIDER_AUTH_ERROR` / `PROVIDER_NOT_FOUND` / `PROVIDER_SERVER_ERROR` / `PROVIDER_HTTP_ERROR` | HTTP 非 2xx，或 SSE 里出现 `error` 事件 |
| `MODEL_CHAT_INVALID_RESPONSE` | 502 | `INVALID_RESPONSE` | 流式数据不是合法 JSON，或整轮没有任何内容 |
| `MODEL_CHAT_RESPONSE_TOO_LARGE` | 502 | `RESPONSE_TOO_LARGE` | 响应体超过 64 KiB |
| `MODEL_CHAT_TIMEOUT` | 504 | `TIMEOUT` | 服务商超时（默认 15 s，取 `runtimeConfig().timeoutMs`） |
| `MODEL_CHAT_NETWORK_ERROR` | 502 | `NETWORK_ERROR` | 连接失败 / DNS 失败等传输错误 |

错误对象沿用 `model-adapter.mjs` 的形状：`{ code, message, statusCode, category, retryable, fallbackEligible }`。
`message` 为中文可读说明，便于直接展示给用户。

## 限制常量

| 常量 | 值 | 位置 |
| --- | --- | --- |
| `MAX_CHAT_MESSAGES` | 32 | `model-chat-adapter.mjs:12` |
| `MAX_CHAT_CONTENT_LENGTH` | 2000 | `model-chat-adapter.mjs:13` |
| `MAX_CHAT_RESPONSE_BYTES` | 64 KiB（同 `model-adapter.mjs` 的 `MAX_RESPONSE_BYTES` 量级） | `model-chat-adapter.mjs:17` |
| `CHAT_TEMPERATURE` / `CHAT_MAX_TOKENS` | 0.2 / 1200 | `model-chat-adapter.mjs:21-22` |
| 超时 | `runtimeConfig().timeoutMs`，缺省 15 s，上限 120 s | `model-chat-adapter.mjs:232` |

## 供应商数据结构（model-provider-store.mjs）

- `publicProvider()`（`:65-78`）新增两个字段：
  - `protocol: "openai-chat"` —— 当前唯一支持的协议；老记录（`normalizeProviderRecord()` 归一化后的记录）
    与新记录一致，UI 可以无条件按该协议渲染。
  - `supportsChat: true` —— 该 provider 可以在规划通道之外直接服务一轮对话，
    UI 据此显示「可对话」标签。
- `normalizeProviderRecord()`（`:108-127`）在返回记录里补 `protocol: "openai-chat"`，
  兼容**没有 protocol 字段的老库**，无需迁移。
- 其它字段语义未变；`apiKey` 依旧**永不返回**（`hasApiKey` 仍是布尔量）。

## 测试

```
node --test tests/phase-150-model-chat-adapter.test.mjs
# tests 18 / pass 18 / fail 0
```

覆盖：正常流式返回且 `onDelta` 按序回调、请求体与请求头契约、`[DONE]` 结束（其后的事件被忽略）、
async `onDelta` 被 await、SSE `error` 事件、HTTP 401、空响应、超过 64 KiB 的响应、
非白名单端点（http 非 loopback / query / userinfo / 非 `/chat/completions` 路径）请求不发出、
loopback 明文 HTTP 允许、无 provider 502、`messages` 非法 400（8 种）、
发起前取消与流中取消 → `MODEL_CHAT_ABORTED`、`status()` 形状、store 抛错不拖垮适配器、
非法依赖抛 `TypeError`。

回归：`node --test tests/phase-140-model-provider-resilience.test.mjs tests/phase-19-model-adapter-contract.test.mjs tests/phase-133-model-fallback-and-scan-bounds.test.mjs` → 34 通过 / 1 跳过。

## 未决事项（交给上层）

1. **`docs/README.md` 缺索引条目**：仓库测试 `tests/docs-links.test.mjs:59` 要求 `docs/` 下每个文档都在
   `docs/README.md` 中列出。本文件是新增文档，需要补一行索引（该文件不在本阶段允许修改的范围内，
   故未改动；注：`phase-146-tool-trace.md` 在本阶段之前就已缺失该索引）。
2. **HTTP 路由未接线**：`server.mjs` 未新增 `POST /api/chat`（或 SSE 端点）。接线时应：
   - 用 `providerStore.runtimeConfig()` 构造 `createModelChatAdapter()`；
   - 把 `onDelta` 写入 `text/event-stream` 响应；
   - 把 `AbortSignal` 与「停止生成」按钮 / 任务取消绑定；
   - 错误映射沿用服务端既有的 `statusCode` → 状态码规则（注意 `MODEL_CHAT_ABORTED` 的 499）。
3. **`model-provider-store.mjs` 的 `add()` / `update()` 写入的记录不含 `protocol` 字段**，
   落盘后由 `normalizeProviderRecord()` 归一化补齐，因此 `list()` 返回的公开对象里
   `protocol` 恒为 `"openai-chat"`、`supportsChat` 恒为 `true`。

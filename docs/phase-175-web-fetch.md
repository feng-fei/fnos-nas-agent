# Phase 175 — 受控网页抓取实现

## 1. 背景

Phase 172 交付了两块基础设施：

- `app/network-policy.mjs`：网络出口策略（`createNetworkPolicy`），
  回答"能不能出网、出到哪、为什么不行"；
- `app/web-evidence.mjs`：证据转换（`buildWebEvidence`），回答"抓回来的
  内容怎么变成可归档、不泄密的证据"。

但中间缺一环：**没有任何代码真的发起请求**。于是 B01 仍然是"有策略无能力"——
策略写得再好，也只是纸上谈兵。本阶段补上这一环：真正把一个**被策略允许**的
URL 抓下来，并转成受控证据。

本阶段仍然**不新增任何 HTTP 路由**：抓取器是纯能力模块，接线与暴露由统一的
一方完成。

## 2. 导出 API

```js
import { createWebFetcher } from "./web-fetch.mjs";

const fetcher = createWebFetcher({
  policy,                 // 必需：network-policy.mjs 产生的策略对象（必须有 isUrlAllowed）
  fetchImpl = null,       // 注入的 fetch 实现（测试用）；缺省走 node:http / node:https
  maxBytes = 2 * 1024 * 1024, // 响应体字节上限
  timeoutMs = 10000,      // 整体超时（毫秒）
  maxRedirects = 3,       // 最大重定向跳数
  now = () => Date.now()  // 时钟
});

const result = await fetcher.fetchEvidence(url, { fetchedAt = "" });
```

返回对象：

```js
{
  ok: boolean,             // 是否成功拿到证据
  evidence: object|null,   // buildWebEvidence 产出的证据对象
  status: number|null,     // HTTP 状态码
  truncated: boolean,      // 响应体是否被字节上限截断
  policy: { allowed: boolean, decision: object|null },  // 判定结果（已抹掉凭据）
  error: null | { code, message, reason, url }          // 失败原因
}
```

`error.code` 取值：`invalid-url`、`network-url-not-allowed`、
`invalid-redirect`、`too-many-redirects`、`missing-content-type`、
`unsupported-content-type`、`fetch-timeout`、`fetch-aborted`、`fetch-failed`。

失败时 `evidence` 恒为 `null`，**绝不返回半截证据**；`policy.decision` 里
的 `url` / `normalizedUrl` 已经抹掉 `user:pass@` 形式的凭据，错误信息里
也不出现凭据。

另导出 `sanitizeUrlForReport(url)`（抹凭据）、常量 `REQUEST_HEADERS`、
`ALLOWED_CONTENT_TYPES`、`DEFAULT_MAX_BYTES`、`DEFAULT_TIMEOUT_MS`、
`DEFAULT_MAX_REDIRECTS`。

## 3. 策略先行的执行顺序

执行顺序是硬约束，**先判定，后出网**：

1. **URL 预处理**：空 URL 直接 `invalid-url`，不发请求。
2. **首次判定**：`policy.isUrlAllowed(url)`。不通过 → 返回
   `ok:false` + `network-url-not-allowed` + `policy.decision`（含 `reason`
   与中文 `detail`），**一个字节都不发**。
3. **建立超时闸门**：`AbortController` + 定时器，到点真的中断请求。
4. **发起请求**：请求头固定为最小集合
   `{ Accept: "text/html,application/xhtml+xml,text/plain" }`。
5. **重定向分支**（301/302/303/307/308）：
   - 用 `new URL(location, 当前地址)` 解析目标；
   - **对目标重新调用 `policy.isUrlAllowed`**——跳到私网必须被拒；
   - 跳数超过 `maxRedirects` → `too-many-redirects`；
   - 目标协议不是 http/https → 由策略判掉（`protocol-not-allowed`）。
6. **内容类型闸门**：`Content-Type` 缺失 → `missing-content-type`；
   不在 `text/html` / `application/xhtml+xml` / `text/plain` /
   `application/json` 之内 → `unsupported-content-type`（错误信息里写明
   实际类型与允许列表）。
7. **有界读取**：按字节上限累积，超限立刻停止累积并中止请求，标记
   `truncated` / `evidence.bodyTruncated`。
8. **转证据**：把正文交给 `web-evidence.mjs` 的 `buildWebEvidence`——
   **本模块不另写一份清洗或脱敏逻辑**。

## 4. 重定向、字节与超时边界

| 边界 | 规则 |
| --- | --- |
| 重定向 | 手动跟随（`redirect: "manual"`），**每一跳都重新过策略**；`maxRedirects` 默认 3，即最多跟随 3 跳，第 4 跳拒绝 |
| 重定向目标 | 相对地址按当前地址解析；目标无法解析 → `invalid-redirect`；状态是重定向但缺 `Location` → `invalid-redirect` |
| 字节上限 | 默认 2 MiB；超限立即停止累积并中止请求；`result.truncated` 与 `evidence.bodyTruncated` 同时为 `true`；`evidence.truncated` 也会被置位（字节截断意味着文本不完整） |
| 超时 | 默认 10 秒，**整体**计时（覆盖所有重定向与正文读取）；到点 `AbortController.abort()` 真的中断请求，错误码 `fetch-timeout` |
| 内容类型 | 只接受 `text/html`、`application/xhtml+xml`、`text/plain`、`application/json`；其余（含 `application/octet-stream`、图片等）一律拒绝 |
| 请求头 | 固定只有 `Accept`；不发 `Cookie`、`Authorization`，也不接受调用方追加请求头 |
| 落盘 | 本模块**不落盘**，只返回内存中的证据对象 |

## 5. 默认网络关闭、需显式放行

抓取器本身**没有**任何默认放行：能不能出网完全由 `policy` 决定，而
`createNetworkPolicy()` 的 `allowList` 默认为空——**空允许列表 = 全部拒绝**
（reason `empty-allow-list`）。

也就是说，即使接上了路由，只要运维没有显式配置出口清单，Web 抓取能力就是
关闭的；这是 Phase 172 定下的"默认关闭、显式批准"的立场，抓取器只是忠实
执行它，不会绕过策略、也不会静默降级（判定不通过就是拒绝，不返回空页面）。

## 6. 测试结果

`node --test tests/phase-175-web-fetch.test.mjs` → **14 个用例全部通过**
（0 fail）。全部使用注入的假 `fetchImpl`，**不访问外网**：

1. 策略拒绝时**不发起任何请求**（调用计数为 0），返回
   `network-url-not-allowed` 与判定理由
2. 允许的 URL 抓取成功，请求头**只有 `Accept`**（无 Cookie / Authorization），
   `redirect: "manual"`
3. 每一跳重定向都重新判定策略（判定调用序列与请求序列一一对应）
4. 重定向到私网地址被拒，且**不会向私网发起请求**
5. 重定向到 `file://` 被拒
6. 重定向跳数超过上限被拒（`too-many-redirects`）
7. 响应体超过字节上限被截断并标记（`truncated` / `bodyTruncated`）
8. 整体超时真的中断请求（`fetch-timeout`）
9. 非文本 `content-type` 被拒并说明原因
10. 缺少 `Content-Type` 被拒
11. 证据里**不含原始 HTML 全文、不含 set-cookie、不含请求头**
12. 错误信息里不含 URL 中的凭据
13. `settings()` 暴露上限与最小请求头
14. 缺少 `policy` 时构造直接抛 `TypeError`

## 7. 遗留限制

- **无真实外网回归**。所有用例都是注入的假 `fetchImpl`，`node:http` /
  `node:https` 的真实链路**没有**被自动化测试覆盖（真实站点会重定向、会
  分块编码、会带 brotli/gzip、连接会慢）。
- **证书校验依赖 Node 默认**。没有自定义 CA、没有 `rejectUnauthorized`
  开关，也不支持自签证书场景；HTTPS 只走 Node 默认的信任链。
- **不处理压缩**。`Content-Encoding: gzip` / `br` 的响应会按原始字节处理，
  会被字节上限提前截断成乱码；解压需要引入依赖或另写实现。
- **不处理分块编码与压缩炸弹的组合**。字节上限作用在**解码后**的字节流上，
  但当前实现未解压，所以上限实际限制的是线上字节数。
- **审计落盘尚未接**。判定理由、目标 URL、跳转链目前只在返回值里，需要
  调用方自行写进 `audit-log`；本模块不落盘、不打日志。
- **无并发与配额控制**。没有并发上限、没有按域名的速率限制、没有全局
  字节预算；`maxBytes` / `timeoutMs` 是单次抓取的上限。
- **无重试**。任何失败（含超时、连接重置）都直接返回，不做退避重试；
  重试策略属于"出网审批"的一部分，尚未定义。
- **不校验重定向后的最终主机是否与原主机同源**。策略只逐跳判定"这个 URL
  能不能访问"，不判断"跨站跳转是否可疑"；允许列表里的站点可以把访问者
  引到别处，只要别处也在允许列表里。
- **`policy.decision` 是快照**。判定发生在请求之前，真实请求期间 DNS 可能
  变化（重绑定），本模块不做二次解析校验。
- **未接入 HTTP 路由**。`server.mjs` / `pages.js` 按要求未改动，抓取能力
  暂时只能在进程内直接调用；接线与索引由统一的一方完成。

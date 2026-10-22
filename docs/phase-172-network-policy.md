# Phase 172 — 网络出口策略与 SSRF 防护 + 受控 Web 取证

## 1. 背景

Marvis 对照表里 **B01–B10（网页信息获取）全部是 Open**，理由只有一条：仓库里
**没有一条明确的网络策略，也没有 SSRF 防护**。

具体表现为三件事：

1. **没有默认关闭的开关**。任何想访问外部网页的能力，都是"直接 fetch"，
   谁的代码路径能走到 fetch，谁就能出网。
2. **没有 SSRF 边界**。Agent 只要能影响目标 URL，就能把请求指向
   `127.0.0.1`、`169.254.169.254`（云元数据）、`10.0.0.0/8` 这类内网地址，
   把"能出网"变成"能读内网"。
3. **没有可归档的证据形态**。网页内容如果原样进日志或诊断上下文，既撑爆
   上下文，又会把页面里的密钥一并带出去。

本阶段补上两样东西：

- `app/network-policy.mjs`：**纯策略**，裁决"能不能出网、出到哪、为什么不行"；
- `app/web-evidence.mjs`：**纯转换**，把"抓取结果"变成受限、可归档、已脱敏的
  证据对象。

两者都不含任何真实抓取代码：本阶段**没有** fetch、没有 DNS 查询、没有新的
HTTP 路由。抓取与审批留给后续接线。

## 2. 默认关闭的设计理由

`createNetworkPolicy()` 的 `allowList` 默认为空数组，而**空允许列表意味着
全部拒绝**（reason = `empty-allow-list`）。

这不是"忘了填默认值"，而是一条明确的产品立场：

- 一个"能出网"的能力，在没有出口清单时**必须是关着的**。如果默认放行，
  任何一次新增调用点、任何一个拼错的 URL 都会变成一次不受控的出网；
- 出口清单是**运维显式批准**的产物，需要人来决定"这个 Agent 到底能访问
  哪些站点"，而不是让代码默认值替你决定；
- "拒绝优先于允许"（denyList 先判）保证一旦某站点被拉黑，任何一条放行
  规则都无法把它捞回来。

`denyList` 永远先于 `allowList` 判定；`allowList` 里的条目可以是主机名
（`example.com`）、通配子域（`*.example.com`，同时匹配 `example.com` 本身）、
带端口的主机（`example.com:8443`）或完整 URL。

## 3. SSRF 防护覆盖面

| 类别 | 覆盖内容 |
| --- | --- |
| 协议 | 只允许 `http` / `https`；`file:`、`ftp:`、`gopher:` 等一律拒绝 |
| 凭据 | URL 中带 `user:pass@` 的形式直接拒绝（凭据会进日志、会进代理） |
| 端口 | 端口必须在白名单内（默认 80 / 443），其余拒绝 |
| IPv4 保留段 | `0.0.0.0/8`、`10/8`、`100.64/10`、`127/8`、`169.254/16`、`172.16/12`、`192.168/16`、`192.0.0/24`、`192.0.2/24`、`198.18/15`、`198.51.100/24`、`203.0.113/24`、`224/4`（组播）、`240/4`（保留） |
| IPv6 保留段 | `::`、`::1`、`fc00::/7`（ULA）、`fe80::/10`（链路本地）、`ff00::/8`（组播）、`2001:db8::/32`（文档） |
| IPv4-mapped IPv6 | `::ffff:10.0.0.1` 这类"长着 IPv6 外皮的私网地址"按内嵌 IPv4 判定；`::10.0.0.1`（IPv4-compatible）、`64:ff9b::/96`（NAT64）、`2002::/16`（6to4）同样按内嵌 IPv4 判定 |
| 本地命名空间 | `localhost`、`*.localhost`、`*.local`、`*.internal`、`*.home.arpa`、`metadata.google.internal`、`host.docker.internal` 等结构性本地名直接拒绝，**不依赖 DNS** |
| 主机名解析 | 注入 `resolver` 后，主机名只要解析到任一保留地址即拒绝（DNS 重绑定的第一道防线） |

**零 DNS 副作用**：模块自身从不调用 `dns.lookup`。主机名的地址归属完全靠
注入的 `resolver` 判定，测试因此可以用一个假 resolver 稳定复现"域名解析到
私网"这一情形。

**未注入 resolver 时的取舍**：默认 `requireDnsVerification = false`，此时
策略只做结构性判定（协议、凭据、端口、名单、本地命名空间、IP 字面量），
判定结果里 `dnsVerified` 为 `false`，`detail` 写明"未做 DNS 地址判定"。
需要"必须验证过 DNS 才放行"的部署可以把 `requireDnsVerification` 打开，
此时未注入 resolver 的主机名一律拒绝（reason = `dns-unverified`）。

## 4. 导出 API

### `app/network-policy.mjs`

```js
import { createNetworkPolicy, normalizeUrl, classifyAddress, POLICY_REASONS } from "./network-policy.mjs";

const policy = createNetworkPolicy({
  allowList = [],            // 允许的主机/模式；为空 = 全部拒绝
  denyList = [],             // 拒绝的主机/模式；优先于 allowList
  allowPrivateRanges = false,// 是否放行私网/回环等保留地址
  maxBytes = 2 * 1024 * 1024,// 响应体上限（供调用方执行）
  timeoutMs = 10000,         // 超时上限（供调用方执行）
  allowedPorts = [80, 443],  // 端口白名单
  resolver = null,           // (hostname) => Promise<string[]>；注入以避免真实 DNS
  requireDnsVerification = false
});
```

策略对象：

| 成员 | 签名 | 说明 |
| --- | --- | --- |
| `isUrlAllowed` | `(url) => Promise<Decision>` | 判定，永远 resolve，**不抛异常** |
| `assertUrlAllowed` | `(url) => Promise<Decision>` | 允许则返回判定，不允许则抛错（`error.statusCode`、`error.reason`、`error.code = "NETWORK_URL_NOT_ALLOWED"`、`error.decision`） |
| `normalizeUrl` | `(url) => string` | 规范化（也作为独立函数导出） |
| `settings` | `() => object` | 当前配置快照：名单、端口、字节上限、超时、DNS 校验模式 |

判定结果 `Decision` 的形状：

```js
{
  allowed: boolean,
  reason: string,        // 稳定标识，见 POLICY_REASONS
  url, normalizedUrl, host, protocol, port,
  addresses: string[],   // 解析到的地址（IP 字面量时是它自己）
  dnsVerified: boolean,
  detail: string         // 人类可读的中文说明
}
```

`POLICY_REASONS`：`allowed`、`invalid-url`、`protocol-not-allowed`、
`credentials-in-url`、`missing-host`、`empty-allow-list`、
`not-allow-listed`、`deny-listed`、`port-not-allowed`、`blocked-address`、
`resolution-failed`、`unresolved-host`、`dns-unverified`。

`normalizeUrl(url)`：去掉 fragment、统一主机小写、去掉默认端口（http 80 /
https 443）、剥掉跟踪参数（`utm_*`、`gclid`、`fbclid`、`msclkid`、`mc_cid`、
`spm`、`_hsenc` 等）、剩余查询参数按键排序。用于审计与去重：同一个页面的
不同分享链接折叠成同一个键。无法解析时返回空字符串。

`classifyAddress(address)` → `{ family, category }`，`category` 取值
`loopback` / `private` / `link-local` / `multicast` / `reserved` / `public` /
`null`，可单独用于别处的地址分类。

### `app/web-evidence.mjs`

```js
import { buildWebEvidence, htmlToText, redactWebText } from "./web-evidence.mjs";

const evidence = buildWebEvidence({
  url, status, contentType, body, fetchedAt,
  policyDecision,     // network-policy 的判定结果
  maxLength = 4000    // 摘要长度上限，硬上限 20000
});
```

证据对象：

```js
{
  type: "web-evidence", source: "web",
  url, status, contentType, fetchedAt,
  policy: { allowed, reason },
  allowed: boolean,
  title: string,        // 从 <title> 提取，上限 200
  excerpt: string,      // 纯文本摘要（已脱敏、已截断）
  length: number,       // 摘要长度
  bytes: number,        // 原始正文字节数
  truncated: boolean,   // 是否发生截断
  redactedFields: string[]  // 被过滤的字段名（小写），不含原文
}
```

另导出两个纯函数：`htmlToText(html)` → `{ title, text }`；
`redactWebText(value)` → `{ text, fields }`。

## 5. 证据转换的边界

- **只保留纯文本摘要**。HTML 会被剥掉注释、`<script>`、`<style>`、
  `<noscript>`、`<title>` 与全部标签，实体解码后压成单行空白；正文**不会**
  原样进入证据（这是"诊断上下文里不能塞整页"的红线）。
- **有硬上限**。摘要默认 4000 字符，硬上限 20000；超限截断并置
  `truncated = true`。
- **脱敏**。赋值形态的密钥（`apiKey=…`、`password: …`、`Authorization: …`）
  值替换为 `[已隐藏]`；常见令牌形态（`sk-` / `pk-` / `ghp_` / `gho_` / `ghs_` /
  `xox*` / `AKIA` / `ASIA` / `AIza` / `ya29` / `github_pat_`）与 JWT
  （`eyJ…`）替换为 `[已隐藏令牌]`；只记录被过滤的**字段名**（小写）到
  `redactedFields`，不记录原文。
- **策略拒绝时不产出正文**。`policyDecision.allowed === false` 时，证据是
  一条**拒绝记录**（`allowed:false`、`excerpt:""`、`bytes:0`），携带拒绝
  理由——**绝不静默降级**成"抓不到就当空页面"。
- **不含网络访问**。本模块不 fetch、不解析 DNS、不落盘；抓取由调用方注入，
  本模块只做"结果 → 证据"的转换。

## 6. 测试结果

`node --test tests/phase-172-network-policy.test.mjs` → **18 个用例全部通过**
（0 fail）。覆盖：

1. 默认关闭：空允许列表 → 全部拒绝（`empty-allow-list`）
2. 显式放行的 http / https 通过判定
3. `file:` / `ftp:` / `gopher:` 被拒
4. 带 `user:pass@` 的 URL 被拒
5. 回环 / 私有 / 链路本地 / 组播 / 保留地址被拒（含 `169.254.169.254`
   元数据地址）
6. IPv4-mapped IPv6 私网被拒；`classifyAddress` 对 `::1` / `fe80::1` /
   `fd00::1` / `ff02::1` 分类正确
7. 注入 resolver 后：解析到私网的主机名被拒、公网主机放行、解析不到地址
   的主机名被拒（`unresolved-host`）
8. 端口白名单：8080 被拒、放行后通过
9. denyList 优先于 allowList
10. 未注入 resolver：本地命名空间被拒、`requireDnsVerification` 时主机名
    被拒（`dns-unverified`）
11. `allowPrivateRanges` 打开后私网地址放行
12. `assertUrlAllowed` 拒绝时抛错（403 / 400、`reason`、`code`）
13. `normalizeUrl` 规范化（fragment、主机大小写、默认端口、跟踪参数、
    查询参数排序）
14. `settings()` 暴露字节上限与超时
15. `buildWebEvidence` 截断、剥离脚本与样式、只留纯文本摘要
16. 密钥 / 令牌脱敏，`redactedFields` 只有字段名、不含原文
17. 策略拒绝时不产出正文
18. `htmlToText` 提取标题并去标签、实体解码

## 7. 遗留限制

- **尚无真实抓取实现**。本阶段只有"策略"和"结果 → 证据"的转换；实际发起
  请求的代码、响应体字节上限的执行、超时的执行都在调用方，仓库里还没有
  这样的调用方。
- **尚无网络出口审批**。名单是**配置**，不是**审批流**：谁改了
  `allowList`、改动是否留痕、是否需要二次确认，都还没有对应机制。
- **DNS 层面的防护依赖注入**。默认不做解析，因此"允许列表里的域名在
  解析后指向 127.0.0.1"这一类重绑定攻击，在未注入 resolver 的部署里只能靠
  调用方自己保证；生产接线时应当注入 resolver 或打开
  `requireDnsVerification`。
- **只挡 IPv4/IPv6 字面量与注入解析结果**，不做 DNS 记录类型检查
  （CNAME 链、TXT 记录），也不防御"同一主机名先后返回不同地址"的重绑定
  时序问题。
- **不支持重定向后的二次校验**。跟随跳转时每一跳都要重新走
  `isUrlAllowed`，本模块不提供"跳转链"的概念，交给调用方实现。
- **`allowPrivateRanges` 是一把大开关**，打开后回环、链路本地、元数据地址
  一并放行，只适合本地开发与受控内网测试。
- **证据摘要会丢结构**。表格、列表、代码块的层级在剥标签时消失，只剩
  顺序拼接的纯文本；标题单独保留，但 `<h1>`–`<h6>` 的层级信息不保留。
- **脱敏是启发式**。自定义格式的凭据（例如自建服务的自有 token 前缀）可能
  漏过；`redactedFields` 只提示不阻断。
- **未接入审计日志**。判定结果目前只能由调用方自行记录；仓库里还没有把
  `reason` 写进 `audit-log` 的接线。
- **未接入 HTTP 路由**。`server.mjs` / `pages.js` 按要求未改动，接线与索引
  由统一的一方完成。

# Phase 198 — 证书检查（纯函数）

本阶段只做「证书检查」的纯函数层：把采集层读到的证书时间字段与 SAN/CN，归一成一份
统一记录，再回答三个问题——**还能用多久**、**给的主机名与证书对不对得上**、
**把两者合起来该给什么结论**。真正的采集（远端 agent 上报、NAS 反代配置读取）
不在本层，本层零 I/O、零依赖、零 import。

- 模块：`apps/fnos-nas-agent/app/certificate-check.mjs`
- 测试：`tests/phase-198-certificate-check.test.mjs`（24 个用例）
- 自验：

```powershell
node --check apps/fnos-nas-agent/app/certificate-check.mjs
node --check tests/phase-198-certificate-check.test.mjs
node --test tests/phase-198-certificate-check.test.mjs
```

## 1. 背景

NAS 上的证书有两种典型故障，而且都发生在「没人打开浏览器」的时候：

1. **悄悄过期**：上次续期失败或 acme 定时任务坏了，证书在 90 天有效期里自然到期，
   第二天所有 HTTPS 访问开始报错，用户才会发现。
2. **名字对不上**：证书换过、反代域名改过、或者客户端用 IP 直连，证书本身没过期，
   但浏览器仍然报 `NET::ERR_CERT_COMMON_NAME_INVALID`。

前者是一个时间判断，后者是一个 SAN/CN 匹配问题，两者合起来才是「这张证书现在能不能用」。
本阶段把这两件事做成可单测的纯函数，采集与告警策略留给后续阶段。

另外，这个模块要回答的问题最容易出的错不是「算错」，而是**把「没读到」说成「没问题」**：
采集失败、字段缺失、日期读不懂时，告警面板上显示一个绿色的 `ok` 比显示红色更危险。
所以本层的结论词表里 `unknown` 是一等公民，且 `ok` 只能在**日期确实被读到且确实安全**时出现。

## 2. 导出 API 与字段

### 2.1 `parseCertificateRecord(input)`

```js
parseCertificateRecord(input: unknown): {
  subject: string | null,
  issuer: string | null,
  notBefore: string | null,   // 统一为 UTC ISO 字符串（毫秒精度）
  notAfter: string | null,
  san: string[],              // 归一后的 "TYPE:value" 条目，最多 50 条
  parsed: boolean             // false = 有字段读不懂
} | null
```

| 字段 | 输入 | 归一结果 |
| --- | --- | --- |
| `subject` | 字符串 | `trim()` 后原样保留（可能是 `CN=...` 也可能是裸名） |
| `issuer` | 字符串 | 同上 |
| `notBefore` / `notAfter` | ISO 字符串或 epoch 毫秒（有限数值） | `YYYY-MM-DDTHH:mm:ss.sssZ` |
| `san` | `string[]` 或 `{type, value}[]` | `"DNS:..."` / `"IP Address:..."` 等统一写法 |
| `parsed` | 按上面几列的结果判定 | 任一字段「给了但读不懂」→ `false` |

返回值约定：

- 输入不是普通对象（`null` / 字符串 / 数字 / 数组）→ 返回 `null`（整条记录不可用）。
- SAN 不是数组、或数组里有无法识别的条目（数字、`null`、缺 `value` 的对象）→ 返回 `null`，
  因为没有 SAN 列表就无法证明「这个名字不在证书里」。
- 缺失（`undefined` / `null` / 空白字符串）的字段 → `null`，但不算失败，`parsed` 仍为 `true`；
  只有「给了但读不懂」（如 `"not-a-date"`）才把 `parsed` 打成 `false`。
- 幂等：`parseCertificateRecord(parseCertificateRecord(x))` 与 `parseCertificateRecord(x)` 深相等，
  调用方可以放心把归一结果当作新记录再用一次。
- SAN 归一：`"dns:x"`、`"DNS:x"`、`{type:"dNSName", value:"x"}` 都归一成 `"DNS:x"`；
  `"IP Address:1.2.3.4"`、`"ipaddress:1.2.3.4"`、`{type:"iPAddress"}` 归一成 `"IP Address:1.2.3.4"`。
  非主机名类型（`email:`、`URI:`、`DirName:`）原样保留，供审计查看，但**不参与**主机名匹配。
- 有界性：SAN 最多保留 `MAX_SAN_ENTRIES` 条，超出的截掉（截断本身会影响匹配结论，见 3.4）。

### 2.2 `daysUntilExpiry(notAfter, now)`

```js
daysUntilExpiry(notAfter: unknown, now: unknown): number | null
```

- 两个参数都接受 ISO 字符串或 epoch 毫秒，内部统一走同一条时间归一函数。
- 返回「整天数」，向负无穷取整：`2026-01-01T12:00Z` 相对 `2026-01-01T00:00Z` 是 `0`
  （还剩半天，但按整天算是 0 天）；`2025-12-31T12:00Z` 是 `-1`（已过期半天）。
- `notAfter` 或 `now` 任一不可解析 → `null`；`now` 为 `NaN`/`Infinity` → `null`。

### 2.3 `matchesHostname(record, hostname)`

```js
matchesHostname(record: unknown, hostname: unknown): true | false | null
```

`true` = 这张证书覆盖这个主机名；`false` = 有证据表明不覆盖；`null` = 信息不足/输入非法，
**不猜**。匹配顺序：

1. 先看 SAN 里的 `DNS:` 条目：任意一条命中即 `true`；一条都不命中即 `false`，**不再回落 CN**。
2. 如果 SAN 里**没有任何** `DNS:` 条目（注意：其它类型的 SAN 不算），才回落 `subject` 的 CN：
   从 DN 里取 `CN=` 那个组件（没有 `=` 的裸值整体当 CN）。
3. IP 字面量主机名只与 SAN 的 `IP Address:` 条目精确相等比较，**不回落 CN**；
   `DNS:1.2.3.4` 这类「DNS 类型里写 IP」不算地址证据。
4. 通配符只允许 `*.` 形式且只在最左一段：`*.example.com` 匹配 `a.example.com`，
   不匹配 `example.com`，也不匹配 `a.b.example.com`。`a.*.com`、`*`、`*example.com`
   这类形态不合法，永不匹配。
5. 大小写不敏感（hostname 与证书名称都先 `toLowerCase()`）；末尾的根点（`nas.example.com.`）
   先剥掉再比。
6. 非法 hostname（空串、含空格、`..`、以 `-` 开头的段、超过 63 字符的段、`*` 通配、
   IPv6 字面量、非字符串）→ `null`；`record` 不可读（`null`/标量/SAN 无法识别）→ `null`。

### 2.4 `summarizeCertificate(record, { now, warnDays = 30, hostname } = {})`

```js
summarizeCertificate(record: unknown, options?: {
  now: string | number,        // 必填：ISO 字符串或 epoch 毫秒
  warnDays?: number,           // 默认 DEFAULT_WARN_DAYS（30）
  hostname?: string
}): {
  verdict: "ok" | "expiring" | "expired" | "invalid" | "unknown",
  daysRemaining: number | null,
  hostnameMatches: true | false | null,
  notes: string[]
}
```

`now` 必须是调用方注入的「当前时间」：本层不读系统时钟，不传时严格按「没读到」处理
（`unknown` + `now-missing`），而不是悄悄用 `Date.now()` 兜底——否则同一份输入在不同时刻
会给出不同结论，测试与审计都不可复现。

判定顺序（第 1 行是早退；第 2–8 行定时间结论，后者不覆盖前者；第 9 行最后覆盖时间结论）：

| # | 条件 | verdict | 是否继续 |
| --- | --- | --- | --- |
| 1 | `record` 不在 `{subject, issuer, notBefore, notAfter, san, parsed}` 形状里 | `unknown` | 停止 |
| 2 | `record.parsed === false` | `invalid` | 继续算时间，但结论已定 |
| 3 | `notAfter` 无法解析 | `invalid` | 时间结论已定 |
| 4 | `notBefore` 无法解析 | `invalid` | 时间结论已定 |
| 5 | `notAfter < notBefore` | `invalid` | 继续算 `daysRemaining` |
| 6 | `daysRemaining < 0` | `expired` | 继续 |
| 7 | `daysRemaining <= warnDays` | `expiring` | 继续 |
| 8 | `daysRemaining > warnDays` | `ok` | 继续 |
| 9 | 给了 `hostname` 且 `hostnameMatches === false` | **`invalid`**（覆盖第 2–8 行的结论） | — |

`now` 缺失或读不懂时没有第 6–8 行的比较可做：`verdict = unknown`，`daysRemaining = null`，
分别记 `now-missing` / `now-invalid`。

- `notes` 是稳定标识符数组（见 2.5），同一 note 不重复；`expiring`/`expired`/`invalid`/`unknown`
  都会带上对应维度的 note，`ok` 只在没给 `hostname` 时带 `hostname-not-checked`。
- 没给 `hostname` 时记 `hostname-not-checked`，`hostnameMatches` 为 `null`——这样调用方不会
  把 `ok` 误读成「名字也校验过了」。
- 给了 `hostname` 但信息不足（`matchesHostname` 返回 `null`）时**只记 note 不改结论**：
  字段缺失记 `hostname-unknown`，hostname 本身非法记 `hostname-invalid`。
- 已证实的名字不符（`false`）是硬失败，即使时间维度是 `ok`（甚至 `unknown`）也把结论压成 `invalid`。

### 2.5 常量

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `CERT_VERDICTS` | `{ OK:"ok", EXPIRING:"expiring", EXPIRED:"expired", INVALID:"invalid", UNKNOWN:"unknown" }` | 冻结 |
| `DEFAULT_WARN_DAYS` | `30` | `summarizeCertificate` 的默认提前告警窗口，可传参覆盖 |
| `MAX_SAN_ENTRIES` | `50` | SAN 归一上限 |
| `CERT_NOTES` | 16 个稳定 id（`record-missing`、`record-unreadable`、`record-invalid`、`not-after-missing`、`not-after-invalid`、`not-before-missing`、`not-before-invalid`、`range-invalid`、`now-missing`、`now-invalid`、`expired`、`expiring`、`hostname-not-checked`、`hostname-invalid`、`hostname-unknown`、`hostname-mismatch`） | 冻结；note 只表达「哪个维度有问题」，不含任何 cert 内容 |

## 3. 语义与安全边界（含「不猜」原则）

### 3.1 五种结论

- `ok`：`notAfter` 确实被读到、确实晚于 `notBefore`、确实还剩超过 `warnDays` 天；
  如果给了 `hostname`，还要求名字匹配结果不为 `false`。
- `expiring`：同上，但剩余 `<= warnDays` 天。默认 30 天，调用方可以按场景覆盖（如 `7`）。
- `expired`：`daysRemaining < 0`，即 `notAfter <= now`。**等于 `now` 也算过期**（剩余天数不为正）。
- `invalid`：证书数据自相矛盾或与使用方式不符——`parsed === false`、时间读不懂、
  `notAfter < notBefore`、已证实的 hostname 不符。这一类**需要人处理**，不是「等等就会好」。
- `unknown`：什么都没读到（`record` 为 `null`/空对象/非对象、`notAfter` 缺失、`now` 缺失或非法）。
  采集失败、以后重试可能就好了，所以与 `invalid` 分开。

### 3.2 已过期与刚好到期的边界

`daysRemaining` 是向下取整，所以 `notAfter === now` 时它是 `0`，落入 `< 0` 之外——为了不在
「到期时刻」给出 `expiring`（那会让人以为还能用），判定用「剩余天数不为正 → expired」：
`0` 天算过期。测试里用 `notAfter: NOW` 固定住了这一条。

### 3.3 SAN 里的 dNSName 优先，CN 只做回落

这是与 RFC 6125 对齐的最小实现：**只要 SAN 里有 `DNS:` 条目，就到 SAN 为止**，
不再看 CN；只有完全没有 dNSName（老证书、或采集层只给了 subject）才回落 CN。
回落时支持 CN 里的通配符（`CN=*.nas.local` 匹配 `a.nas.local`），规则与 SAN 相同。
非 dNSName 类型的 SAN（`email:` 等）存在时**不阻止** CN 回落——它们不提供主机名证据。

### 3.4 「不猜」原则

1. **信息不足返回 `null`，不返回 `false`。** `matchesHostname` 在「没有 dNSName 也没有 CN」时
   返回 `null`；`summarizeCertificate` 只记 note，不改结论。
2. **截断的列表不算否定证据。** 归一后 SAN 条目数达到 `MAX_SAN_ENTRIES` 时，匹配结果若
   是「没找到」则返回 `null` 而不是 `false`——列表可能被截断，`false` 会是假否定。
   列表里命中的条目仍然返回 `true`（肯定结论不受截断影响）。
3. **不认识就是 `invalid`，不是 `ok`。** 日期读不懂、`notAfter` 早于 `notBefore`、
   采集层自己标了 `parsed: false`，都不放进 `ok`/`expiring`。
4. **没有宿主名上下文就不假装校验过。** 不给 `hostname` 时记 `hostname-not-checked`。
5. **数字一律按 epoch 毫秒读。** 传 `20260101` 不会被猜成 `2026-01-01`，只会被当成
   1970 年附近的毫秒值（测试里固定为 `-20454` 天）。日期字符串必须是带时区的 ISO 8601
   （或 `YYYY-MM-DD`，按 UTC 处理），`Jan 1 2026 GMT`、`01/02/2026`、无时区的
   `2026-01-01T00:00:00` 一律 `invalid`——宁可报「读不懂」，也不猜本地时区。
6. **时间基准必须由调用方给。** 本层不读系统时钟：不传 `now` 就是 `unknown` + `now-missing`，
   不会用 `Date.now()` 兜底（否则同一份输入在不同时刻结论不同，不可复现）。

### 3.5 归一与两种输入

- 时间字段可以是 ISO 字符串或 epoch 毫秒，同一条记录里混用也没问题；归一结果统一是
  `toISOString()` 的字面量，毫秒以下截断。
- `Date` 对象**不**被当作合法输入（返回 `parsed: false`）：它的可序列化形态不稳定，
  调用方应自己 `getTime()`。
- SAN 条目按 `TYPE:value` 归一，别名大小写不敏感；裸字符串按语法粗判（IPv4 → `IP Address`，
  其余 → `DNS`），IPv6 裸字面量按 DNS 处理（不猜）。

### 3.6 参数校验：只有用错 API 才抛异常

- `summarizeCertificate(record, null)` 或第二个参数不是对象 → `TypeError`。
- `warnDays`：`undefined` 用默认 `30`；**`0`、负数、`NaN`、`Infinity`、字符串、`null`、
  `true`、对象一律 `TypeError`**，不做静默回落。理由：`warnDays: 0` 通常意味着调用方
  想关掉提前告警但写错了字段，静默回落成 30 会让「不该报的报了」很难排查；
  显式抛错能让调用点立刻暴露。本层**不提供**「关掉提前告警」的开关：只想看 `expired` 的调用方
  直接按 `verdict === "expired"` 过滤，而不是用 `warnDays: 0` 表达这个意图。
- 数据本身的问题（非法日期、非法 hostname、不可读 record）**不抛异常**，走返回值 + note。

### 3.7 语义取舍

- **为什么不直接用 `new Date(text)` 判断日期**：V8 对 `"Sep 16 18:42:52 2026 GMT"`、
  `"2026-02-30"`（会进到 3 月）这类输入悄悄给出结果或日期滚动。证书时间必须是
  「精确、无歧义」的，所以先做白名单形状校验，不接受任何需要猜的形态。
- **为什么 `parsed: false` 在时间可读时也算 `invalid`**：采集层已经明确说「有字段读不懂」
  时，我们不应只挑能读的字段继续算，那是用局部信息冒充整体结论。
- **为什么过期的判据是「剩余天数不为正」而不是 `< 0`**：告警系统的用户看的是
  「还剩几天」，「还剩 0 天」语义上就是今天到期、不可用；判 `< 0` 会把到期当天报成
  `expiring`，误导运维以为还有缓冲。
- **为什么 hostname 不符覆盖 `expired`/`expiring`**：两者都需要人处理，但名字不符意味着
  「这张证书根本不该用在这个域名」，优先级更高，避免运维只看到「快过期了」去续期，
  续完仍然不对。
- **为什么 `notes` 用英文稳定 id 而不是人类可读句子**：方便 UI 建映射、方便测试断言、
  也顺带保证 note 里不会混进证书内容（隐私）。`notes` 去重由内部的 `pushNote` 统一保证，测试里
  用 `new Set(notes).size === notes.length` 固化了这一契约。
- **为什么 IP 不回落 CN**：现代客户端（Chrome、Go、curl、Node）只认 SAN 的 `iPAddress`，
  CN 里的 IP 早已不被信任；回落只会给出一个「看起来能用」的假 `true`。

## 4. 测试结果

环境：Node v22.22.0、Windows、本机；无网络、无真机、无文件读写测试数据。

```text
node --check apps/fnos-nas-agent/app/certificate-check.mjs
node --check tests/phase-198-certificate-check.test.mjs
node --test tests/phase-198-certificate-check.test.mjs
```

结果为 **24 tests / 24 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**：

```text
# tests 24
# pass 24
# fail 0
```

耗时约 159 ms。覆盖点：

- 正常未过期、`warnDays` 边界（正好 30 天 = expiring、31 天 = ok）、已过期、`notAfter === now`
- `notAfter` 早于 `notBefore`、非法日期字符串、`notBefore` 非法
- 空输入（`null`/`undefined`/标量/数组/空对象/空白字段）→ `unknown`，且断言结论不为 `ok`
- `now` 缺失（`now-missing`）与非法（`now-invalid`）都只给 `unknown`，不会冒充 `ok`
- ISO 与 epoch 毫秒两种输入（含混用）得到同样的记录与结论
- 通配符匹配与不匹配（含单层子域 `a.example.com`、裸域 `example.com`、深层子域
  `a.b.example.com`、形似域 `badexample.com`）
- IP SAN（`IP Address:` 精确相等、`DNS:` 写的 IP 不算、不回落 CN）、
  `20260101` 这类数字按 epoch 解释
- CN 回落（有 dNSName 时不回落、只有非 dNSName SAN 时仍回落、无 CN 时 `null`）
- 大小写不敏感、末尾根点
- 非法 hostname（空格、`..`、`-` 开头、`*.`、IPv6、超长 label）→ `null`
- hostname 不匹配 → `invalid`；hostname 信息不足 → 只记 note、结论不变
- `warnDays` 非法（`0`/负数/`NaN`/`Infinity`/字符串/`null`/`true`/对象）抛 `TypeError`，
  非对象 options 也抛 `TypeError`
- SAN 截断边界：50 条时未命中断言 `null`、49 条时未命中断言 `false`
- `notes` 去重、格式为小写 kebab 标识符、不含 subject/SAN/hostname 内容
- 源码纯度：无 `import`/`require(`/`node:*`/`fetch(`/`process.`/`execSync`，不调外部工具

## 5. 遗留

1. **`docs/README.md` 未登记本阶段文档**（本阶段硬约束：不修改既有文件）。
   `tests/docs-links.test.mjs` 要求 `docs/` 下每个文件都被 `docs/README.md` 链接，
   因此完整跑 `node --test` 会报
   `every document must be listed in docs/README.md: phase-198-certificate-check.md`。
   需要 Lead 在 `docs/README.md` 里补一行登记后才会转绿；本模块与单测本身不依赖该登记。
2. **采集层未实现**：谁去取证书（远端 agent、NAS 反代配置、TLS 握手）、多久取一次、
   失败如何重试，都不在本阶段范围内。
3. **告警策略未实现**：`expiring` 在 UI 上显示什么颜色、是否系统通知、是否进
   `/system/events`，留给后续阶段；`notes` 的 id 是给那时建映射用的。
4. **通配符与 IDN 的边界**：当前只支持最左一段 `*.` 通配符与 ASCII 主机名；
   `*` 出现在中间、Punycode 之外的 Unicode 主机名、`subjectAltName` 里的其他通用名类型
   （`URI`、`email`）都不参与匹配。需要时再扩展。
5. **`now` 必填、由调用方注入**：模块刻意不读系统时钟，定时任务务必传入真实时间；
   不传 `now` 时本层返回 `unknown`（`now-missing` note），不会用 `Date.now()` 兜底。
6. **`matchesHostname` 的 CN 回落策略待与真机核对**：本层按 RFC 6125 的常见实现（无 dNSName
   才回落 CN）处理；如果 NAS 上某些老客户端仍走 CN，需要按实际抓包结果再调整。

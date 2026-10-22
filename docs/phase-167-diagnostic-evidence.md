# Phase 167 — 诊断证据源接入

本阶段实现用户功能清单中模块 03「AI 故障诊断与自动修复」的**证据来源层**。
Phase 162 已经交付 `app/diagnostics.mjs`（`buildDiagnosticReport` / `classifyEvidence` /
`rankCauses` / `isSafeSuggestion`），但它只能消费调用方**传入**的证据，诊断引擎本身
并没有真正的证据来源——这正是能力对照表里最大的缺口。

本模块把仓库里已经存在的四类记录整理成 `buildDiagnosticReport()` 需要的 evidence 形状：

| 来源 | 数据来源模块 | 进入证据的白名单字段 |
| --- | --- | --- |
| `audit` | `app/audit-log.mjs` 落盘的审计记录 | `at` `method` `route` `statusCode` `outcome` `toolId` `risk` `target` |
| `trace` | `app/tool-trace.mjs` 的工具调用轨迹 | `toolId` `risk` `outcome` `errorClass` `durationMs` `startedAt` `endedAt` |
| `health-check` | `app/scheduled-health-checks.mjs` 的巡检状态 | `name` `type` `lastStatus` `lastRunAt` `lastSummary` |
| `snapshot` | `app/system-snapshot.mjs` 的系统快照分段 | `id` `title` `status` `note` + `values` 里的数值型白名单键 |

## 1. 变更边界

本阶段**只新增**三个文件：

| 文件 | 作用 |
| --- | --- |
| `apps/fnos-nas-agent/app/diagnostic-evidence.mjs` | ES module，纯函数，无 I/O、无模型调用、无第三方依赖 |
| `tests/phase-167-diagnostic-evidence.test.mjs` | `node --test` 用例 |
| `docs/phase-167-diagnostic-evidence.md` | 本文档 |

明确**没有**发生的事：

- 没有修改任何既有生产模块（含 `server.mjs`、`diagnostics.mjs`、`audit-log.mjs`、`tool-trace.mjs`、
  `scheduled-health-checks.mjs`、`system-snapshot.mjs`）与 UI；
- 没有新增、修改或删除任何 HTTP 路由；
- 没有修改 `README.md` / `docs/README.md` / 发布门禁脚本（索引同步由 lead 统一做）；
- 没有引入任何第三方依赖；
- 没有执行 `git commit` / `git push`。

本模块**不执行**任何命令、不做文件 I/O、不调用任何模型；输入是调用方已经采集到的记录，
输出是分类候选、候选证据与报告文本。

## 2. 导出 API 契约

```js
import {
  DIAGNOSTIC_EVIDENCE_SOURCES,
  MAX_EVIDENCE_PER_SOURCE,
  MAX_EVIDENCE_TOTAL,
  collectDiagnosticEvidence,
  buildEvidenceBundle
} from "../apps/fnos-nas-agent/app/diagnostic-evidence.mjs";
```

| 导出 | 签名 | 返回 | 说明 |
| --- | --- | --- | --- |
| `DIAGNOSTIC_EVIDENCE_SOURCES` | `readonly string[]` | `["audit","trace","health-check","snapshot"]` | 来源枚举，顺序即收集顺序 |
| `MAX_EVIDENCE_PER_SOURCE` | `number` | `50` | 每个来源的证据条数上限 |
| `MAX_EVIDENCE_TOTAL` | `number` | `200` | 所有来源合计的证据条数上限 |
| `collectDiagnosticEvidence` | `({auditEntries=[], traceEntries=[], healthChecks=[], snapshots=[], now=null}) => Evidence[]` | 证据数组 | 每条形如 `{source, detail, at?, category?, truncated?}` |
| `buildEvidenceBundle` | `({auditEntries=[], traceEntries=[], healthChecks=[], snapshots=[], symptom="", maxEvidence=MAX_EVIDENCE_TOTAL, now=null}) => Bundle` | `{evidence, truncated, stats}` | `evidence` 已是 `buildDiagnosticReport()` 可直接消费的 `{source, detail}` 形状 |

`buildEvidenceBundle()` 的返回值：

- `evidence: Array<{source, detail}>`——只含 `source` 与 `detail` 两个键，与
  `diagnostics.mjs` 的 `normalizeEvidence()` 输出形状一致；
- `truncated: {bySource: object, total: boolean}`——哪些来源被截断、总量是否触顶；
- `stats: {collected, unique, duplicatesRemoved, matched, limited}`——去重与裁剪统计。

## 3. 字段白名单

白名单是**双层**的：既限制"从记录里读哪些字段"，也限制"字段名本身是否属于禁止类"。

禁止类字段名（大小写不敏感，按子串匹配）：

```
prompt  apiKey  api-key  secret  token  password  passwd  credential
authorization  cookie  sessionValue  stack  traceback  userMessage  userText
```

命中禁止类的字段**永远不会被读取**，因此提示词、密钥原文、原始异常栈不会进入证据。

除此之外还有两道内容级清洗（作用在最终 detail 文本上）：

1. **密钥形态抹除**：`apiKey=xxx` / `token: xxx` 形式的赋值被替换成 `key=[redacted]`；
   `sk-` / `ghp_` / `xoxb-` 等常见令牌前缀整体替换成 `[redacted]`。
2. **异常栈抹除**：行首栈帧（`    at Foo.bar (...)`）与行内栈片段
   （`at Foo.bar (/app/x.js:1:1)`）都会被删除；证据里因此不会出现本机路径。

控制字符与换行在进入 detail 前被统一替换成空格，单条 detail 上限 240 字符。

## 4. 截断规则

| 规则 | 值 | 行为 |
| --- | --- | --- |
| 每来源上限 | `MAX_EVIDENCE_PER_SOURCE = 50` | 超出的记录直接丢弃；该来源**保留的最后一条**证据打上 `truncated: true` |
| 总量上限 | `MAX_EVIDENCE_TOTAL = 200` | 触顶时最后一条证据打上 `truncated: true`，`buildEvidenceBundle().truncated.total` 为 `true` |
| 单条长度 | 240 字符 | 超出部分截断并加省略号 |

`truncated` 标记的含义是"证据可能不完整"，报告据此提示补充证据，而不是伪装成完整结论。

## 5. 去重规则

`buildEvidenceBundle()` 用 `source + " " + detail` 作为归一化去重键：**同一来源、同一明细**
的证据只保留一条，重复条数记在 `stats.duplicatesRemoved`。因此同一症状不会重复收录同一条证据。

排序上，与 `symptom` 相关的证据排在前面（`stats.matched` 记录命中条数），无关的排在后面；
顺序稳定，重复调用结果一致。

## 6. 测试结果

```
node --test tests/phase-167-diagnostic-evidence.test.mjs
```

**19 个用例，19 通过，0 失败。**

| 用例 | 覆盖点 |
| --- | --- |
| 来源枚举 | 四个允许的 source 取值 |
| 审计来源 | 明细包含 method/route/status/outcome，带 `at` |
| 轨迹来源 | 明细包含 tool/risk/error/durationMs |
| 定时巡检来源 | 明细包含 name/type/lastStatus |
| 系统快照来源 | `{sections:[...]}` 与数组两种形态都能产出证据 |
| 提示词白名单 | `prompt` / `userText` 字段不进入证据 |
| 密钥白名单 | `apiKey` / `token` / `authorization` / `lastSummary` 里的密钥形态被抹除 |
| 异常栈白名单 | 栈帧与本机路径不进入证据 |
| 快照数值白名单 | 非白名单键（`secretMetric`）与密钥键不进入证据 |
| 每来源截断 | 超过 50 条时最后一条带 `truncated: true` |
| 总量截断 | 超过 200 条时截断并打标记 |
| 去重 | 重复证据只保留一条，`duplicatesRemoved` 计数正确 |
| bundle 形状 | 每条只有 `source` 与 `detail` 两个键 |
| 症状优先排序 | 相关证据排前面，`stats.matched` 正确 |
| 空输入 | 返回空数组，不臆造任何证据 |
| `maxEvidence` | 可进一步收窄，`stats.limited` 记录丢弃条数 |
| 畸形记录 | `null` / `{}` / 非对象被安全跳过 |
| 兜底时间戳 | `now` 补到没有 `at` 的证据上 |
| 去重键含来源 | 来源不同的同文本证据互不吞并 |

## 7. 遗留限制

- 本模块**不采集**证据，只整理调用方传入的记录；`server.mjs` 尚未接线，真实运行时
  仍需由 lead 把审计日志、工具轨迹、巡检状态与系统快照喂进来。
- `at` 时间戳沿用来源记录的原值，不做时区归一。
- 轨迹来源不含工具参数与返回结果（`tool-trace.mjs` 有意不存），因此涉及"传了错参数"的
  症状无法从证据侧直接定位。
- 快照只采集白名单数值键；`disks` 之类的数组型指标暂不进入证据。
- 证据文本是英文键值对（`status=` / `outcome=` 等），与 `diagnostics.mjs` 的信号匹配正则
  兼容；后续若要出中文报告，需要在 `diagnostics.mjs` 侧做映射，本阶段刻意未改该文件。
- 去重按精确文本进行，不做语义近似去重；同义但措辞不同的证据仍会同时出现。

## 8. 后续建议

- 在 `server.mjs` 增加一个只读的 `/api/diagnostics/evidence` 路由，把
  `buildEvidenceBundle()` 的结果直接交给 `buildDiagnosticReport()`；
- 为 `truncated` 情况补一条"证据不足，建议先补采 X"的报告文案；
- 后续阶段可引入"症状关键词 → 证据来源"的路由表，进一步提高 `matched` 比例。

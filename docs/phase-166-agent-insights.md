# Phase 166 — Agent 观察与自省能力

## 背景

Phase 160–165 各自交付了安全审计、系统快照、诊断、重复检测、MCP 服务端与用量统计的模块，但这些模块彼此独立，而且没有一个统一的 HTTP 出口把它们暴露给运维界面。Marvis 的做法是：Agent 在同一会话里既能读系统真实状态，又能解释自己的行为。本阶段把这两件事收进一条可验证的通道。

本阶段只做"看"与"算"，不做任何"改"：

- 读取 NAS 真实状态（CPU/内存/存储/网络/Docker/服务），测不到的段落显式标记为 `unknown`；
- 汇总自身工具调用与模型用量，但只保留计数器，不保留提示词原文；
- 生成只读诊断报告，给出候选根因与验证动作，并强制过滤危险动作；
- 以 MCP stdio 方式对外发布只读工具目录，供外部客户端发现。

## 新增/变更的代码

| 文件 | 作用 |
| --- | --- |
| `apps/fnos-nas-agent/app/agent-insights.mjs` | 新增。`estimateTokens(value)`（按长度/4 估算，单条上限 100000 字符）、`buildUsageEntry({provider,model,endpoint,outcome,promptText,completionText,latencyMs,privacyMode})`（生成不含原文的用量条目）、`createSystemCollector({trimCli})`（按段落采集真实状态，采不到返回 `unavailable`） |
| `apps/fnos-nas-agent/app/mcp-stdio-entry.mjs` | 新增。stdio JSON-RPC 2.0 入口，`initialize` 返回 `protocolVersion: "2024-11-05"`，`tools/list` 只发布只读工具 |
| `apps/fnos-nas-agent/app/server.mjs` | 变更。新增 `usageMeter`（`createUsageMeter({maxEntries:500})`）、`recordChatUsage(...)`（直聊链路记账）、四个只读路由与审计路由名 `system.snapshot` / `diagnostics.report` / `security.inspection` / `models.usage` |
| `tests/phase-166-agent-insights.test.mjs` | 新增。6 个用例覆盖单位层、HTTP 层与 MCP stdio 握手 |

## HTTP 出口

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/system/snapshot` | GET | 6 个段落（cpu/memory/storage/network/docker/services）的真实状态快照，含 `generatedAt` 与未覆盖项清单 `uncovered` |
| `/api/security/inspection` | GET | 6 个安全段落的巡检结果 + 工具权限表 `toolPermissions` + 审计摘要 `auditSummary` |
| `/api/models/usage` | GET | 用量汇总 `summary`、按模型分组 `byModel`、隐私模式状态 `privacy` |
| `/api/diagnostics/report` | POST | 只读诊断报告：候选根因、验证检查、后续建议 |

四个路由全部要求登录会话（未登录返回 `401`），`POST` 路由额外执行同源校验（跨源返回 `403`）与 `application/json` 校验（返回 `415`）。

## 隐私与安全边界

- 用量记录只保存计数器：`promptTokens` / `completionTokens` / `latencyMs` / `outcome` / 模型名，**不保存提示词与回答原文**。
- 隐私模式是"报告开关"而不是"拦截开关"：`/api/models/usage` 的 `privacy.enforced` 显式为 `false` 并附中文说明，避免运维误以为云端请求已被阻断。
- 未知价格不猜：`summary.priced` 为 `false`，由部署方自行填价目表。
- 诊断报告的每一条 `nextSteps` 与 `readOnlyChecks` 都经过 `isSafeSuggestion()` 过滤：`rm -rf`、`mkfs`、`dd of=/dev/`、`mdadm --stop`、重建阵列、停止存储服务、重启所有服务等动作一律不得出现在建议里。
- 系统快照采不到的段落返回 `unavailable` 并附 `note`，绝不伪装成"健康"。

## 验证

`node --test tests/phase-166-agent-insights.test.mjs` → **6 tests / 6 pass / 0 fail**：

1. `estimateTokens` 对空值不抛错，长度按 1/4 估算；
2. `buildUsageEntry` 拒绝无法归属 provider 的条目，且序列化结果不含提示词原文；
3. 用量计量器统计请求数/成功失败/token，并保持"未知价格不计价"；隐私模式下云端请求被计入 `cloudRequestsBlocked`；
4. 系统采集器读官方 CLI 的 `monitor.cpu` / `monitor.memory` 并换算百分比，缺失源返回非 ok；
5. MCP stdio 入口完成 `initialize` + `tools/list` 握手且工具目录非空；
6. HTTP 层：四个新路由未登录 `401`；登录后快照 6 段、巡检 6 段 + 工具权限表 + 审计摘要、用量 `requests=0`；诊断报告跨源 `403`、正常返回且建议中不含 `rm -rf`。

## 遗留

- MCP stdio 入口当前只发布只读工具目录；写操作仍走 HTTP 侧审批队列，不会经由 stdio 暴露。
- 快照采集依赖官方 `trim-cli`；CLI 未安装时相应段落为 `unavailable`，不提供模拟值。
- 诊断报告的根因候选依赖调用方提供的 `evidence`，目前 HTTP 路由传入空候选，根因匹配主要在模块层完成。

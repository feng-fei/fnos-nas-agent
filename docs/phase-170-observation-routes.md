# Phase 170 — 运行手册与工作流的接线

## 背景

Phase 167（诊断证据源）、Phase 168（工作流引擎）、Phase 169（运行手册库）三个模块已经落盘，但它们都停在进程内，界面上看不到，HTTP 客户端也用不上。对照表里 K01–K10 与 W02–W08 的缺口正是「有模块、无出口」。

本阶段把这三个模块接进服务，并补一条只读的观察出口 `/api/diagnostics/evidence`，让诊断报告有真实证据可依。

## 新增与变更的代码

| 文件 | 变更 |
| --- | --- |
| `apps/fnos-nas-agent/app/server.mjs` | 新增 4 个导入（`runbook-store`、`diagnostic-evidence`、`workflow-engine`），新增运行手册库、工作流引擎实例与内置计划注册函数，新增 8 条路由与 5 条审计路由名 |
| `tests/phase-170-observation-routes.test.mjs` | 新增真实 HTTP 集成测试（启动服务端进程，跑完 401 → 登录 → 写入 → 检索 → 工作流 → 删除全链路） |

## HTTP 出口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/runbooks` | 列出运行手册，支持 `tag`、`limit`、`offset` |
| GET | `/api/runbooks?q=` | 检索运行手册，命中标题、标签与正文 |
| GET | `/api/runbooks/stats` | 条目数、标签与最近更新时间 |
| GET | `/api/runbooks/:id` | 读取单条运行手册 |
| POST | `/api/runbooks` | 写入一条运行手册（写入前脱敏，拒绝覆盖同 id） |
| DELETE | `/api/runbooks/:id` | 删除一条运行手册 |
| GET | `/api/workflows` | 列出内置工作流计划 |
| POST | `/api/workflows` | 运行一个工作流计划 |
| GET | `/api/workflows/:id/events` | 读取工作流事件 |
| GET | `/api/diagnostics/evidence` | 读取当前可采集的诊断证据 |

## 执行语义与安全边界

* 全部路由沿用现有会话校验：`/api/runbooks`、`/api/runbooks/stats`、`/api/runbooks/:id`、`/api/diagnostics/evidence`、`/api/workflows` 未登录一律 401；写路由要求同源与 `application/json`。
* **工作流不自行批准任何步骤**：服务端注入的 `requestApproval` 恒返回未批准，因此任何带 `approval` 的步骤都会被跳过；工具执行权来自工具目录，引擎本身没有 I/O。
* **内置计划只用只读工具**（`storage.summary`、`system.process-summary`、`network.interfaces`、`files.inspect`、`documents.index-status`），只看不改。
* **运行手册写入前脱敏**：文本里混入的凭据被替换，只回报被过滤的字段名，原文不落库。
* **诊断证据按白名单采集**：审计日志、工具轨迹、巡检状态、系统快照只读取允许字段，提示词、密钥、异常栈不进入证据；每来源上限 50 条、总量上限 200 条。
* 工作流同一 id 同时只允许一个实例，重复调用返回 409。

## 验证结果

* `node --test tests/phase-170-observation-routes.test.mjs` → 1 test / 1 pass（真实 HTTP 全链路）。
* `node --test tests/phase-167-diagnostic-evidence.test.mjs` → 19/19；`tests/phase-168-workflow-engine.test.mjs` → 23/23；`tests/phase-169-runbook-store.test.mjs` → 13/13。
* `node --check apps/fnos-nas-agent/app/server.mjs` → 通过。

## 遗留限制

* 工作流计划目前是内置常量，界面还不能新建或编辑计划。
* 工作流的审批通道尚未接入「待确认动作」队列：需要人工批准的步骤一律跳过，等待专门的会话审批接口。
* 诊断证据目前只覆盖审计、轨迹、巡检、快照四类来源，日志文件与 SMART 明细仍未接入。

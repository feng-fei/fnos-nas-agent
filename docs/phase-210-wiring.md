# Phase 210 — 把 203–209 接到 HTTP 上，并修好审计白名单

## 背景

Phase 203–209 各自交付了一层纯函数（系统只读工具、Docker 采样、网络采样、触发判定、
日志证据、设备档案、技能组合），每一层都有自己的测试，但**没有任何一个路由调用它们**。
纯函数层没有出口，对机主来说等于不存在；这一阶段只做两件事：

1. 把七层接到 HTTP 与工具注册表上，形成真正能用的入口；
2. 修一个被连带暴露出来的老问题：审计白名单没跟上新增路由名，新路由的审计记录
   会被静默归一成 `other_api`。

## 新增与变更

| 文件 | 变更 |
| --- | --- |
| `apps/fnos-nas-agent/app/server.mjs` | 接入 7 个新路由、7 个系统只读工具、4 组审计名 |
| `apps/fnos-nas-agent/app/docker-stats-collector.mjs` | 新增：把 `docker stats` 的 execFile 从 server 里挪出来（架构闸门禁止 server 直接起子进程） |
| `apps/fnos-nas-agent/app/audit-log.mjs` | 审计白名单由 44 个名字补到 97 个 |
| `tests/phase-210-wiring.test.mjs` | 新增：5 个用例（HTTP 全链路 2 个、采集器 1 个、白名单一致性 1 个、架构不变量 1 个） |
| `scripts/sync-audit-routes.mjs` | 新增：比对 `auditRoute()` 与白名单，可 `--write` 自动补齐 |

## HTTP 出口

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/docker/stats` | 采样本机容器，回 `summary` 与 `containers`；读不到时回 `unknown` 与 `notes` |
| GET | `/api/network/interfaces` | 解析 `/proc/net/dev`；没有该文件时回 `verdict: "unknown"` 与空列表，绝不当成 0 吞吐 |
| POST | `/api/workflows/triggers/evaluate` | 只判定该触发哪些工作流，**不执行**；非法规则进 `notes` |
| GET | `/api/diagnostics/log-evidence` | 用日志尾部拼证据；只保留类别、级别与计数，不带原始行 |
| GET/PUT/DELETE | `/api/system/device-profiles[/:id]` | 机主自述硬件与偏好；凭据字段直接丢弃，序列号只留后 4 位 |
| POST | `/api/compositions/validate` | 校验技能组合（七类错误），只判不跑 |
| POST | `/api/compositions/plan` | 按拓扑序给出运行计划：每步的 `condition-met` / `skipped` 与合并后的权限 |

所有写路由（PUT/DELETE）都过既有 `sameOrigin()` 检查；所有路由都要求会话，401/405/415/400
与既有路由保持一致。

## 工具注册表

七个系统事实工具通过 `createSystemToolDefinitions()` 生成定义，再并进既有注册表，
因此**自动获得**既有的四项保护：只读风险裁决、HTTP 工具面板、MCP 桥接、任务事件流。
工具 id：`services.list`、`smart.summary`、`thermal.status`、`events.recent`、
`snapshot.summary`、`capabilities.get`、`capacity.forecast`。

只读系统工具一律 `risk: "read-only"`；`smart.summary` 在采集器关闭时返回 `verdict: "unknown"`
与原因，而不是空成功。

## 审计白名单（这一阶段修掉的真实缺陷）

`audit-log.mjs` 的 `normalizeEvent()` 用一张 `ROUTES` 白名单归一化路由名，
不在表里的名字会被替换成 `other_api`。自 Phase 177 起新增的路由名从未登记，
于是这些路由的审计记录全部落成 `other_api` —— 日志里看不出是哪个动作。

本阶段把白名单补到 97 个名字（`scripts/sync-audit-routes.mjs` 自动比对），
并加了一条静态用例：`auditRoute()` 里出现的每个名字都必须在白名单里，
漏一个就红。这样以后新增路由不会再静默丢名字。

## 安全边界

- 七个新路由全部只读（写路由只有设备档案的 PUT/DELETE，且过 `sameOrigin`）。- 日志证据只保留类别/级别/计数，原始行不出后端；设备档案的凭据字段在入库前丢弃。
- 触发判定不执行任何工作流；组合校验/计划不调用任何技能。
- 系统只读工具不新增命令执行面：仍然只走既有固定 argv 的 `trim-cli` 与只读文件接口。
- 审计白名单只影响记录名，不改变鉴权。

## 被闸门拦下的两件事

1. **server.mjs 不许直接起子进程**：`scripts/check-release-gates.mjs` 断言 server 里
   不出现 `node:child_process` 导入。Docker 采集最先写在 server 里，被这条断言拦下，
   于是独立成 `docker-stats-collector.mjs`，`execFile` 仍可注入，测试不需要真 Docker。
   这条不变量现在也有用例守着。
2. **文档索引要精确**：`docs/README.md` 的计数句与目录清单由闸门逐字校验，
   这一阶段新增的 8 篇文档全部登记，计数句为 211 篇（195 阶段文档 + 15 非阶段文档）。

## 验证

- `node --test tests/phase-210-wiring.test.mjs` → 3/3 通过
- `node scripts/check-release-gates.mjs` → 通过
- 全量 `node --test`：失败集合与上一轮（`4c1e834`）逐条比对，无新增失败。

## 遗留

- UI 还没有这些新路由的入口（设备档案、技能组合、触发判定）。当前它们只有 HTTP 与工具通道。
- `capacity.forecast` 工具复用了只读的容量预测路由，历史上限为进程内内存，进程重启即清空。

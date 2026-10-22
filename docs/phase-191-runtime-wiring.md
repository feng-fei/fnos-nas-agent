# Phase 191 — 服务状态、容量趋势与批量重命名的接线

## 背景

Phase 188/189/190 各交付了一个「纯逻辑层」：

| 模块 | 能力 |
| --- | --- |
| `apps/fnos-nas-agent/app/capacity-forecast.mjs` | 采样清洗、趋势摘要、容量预测（纯函数） |
| `apps/fnos-nas-agent/app/batch-rename.mjs` | 批量改名计划与可回滚执行器（纯函数 + 注入 rename） |
| `apps/fnos-nas-agent/app/service-status.mjs` | unit 名校验、`systemctl show` 解析、逐条结论（纯函数） |

三个模块都没有出口——没有路由、没有按钮、没有采集器。这一阶段就是补上这三件事：
**谁去采集、从哪个接口拿、在界面上怎么看、改名怎么才敢按下去**。

## 新增代码

| 文件 | 作用 |
| --- | --- |
| `apps/fnos-nas-agent/app/service-status-collector.mjs` | 唯一碰系统的地方：固定 argv 调 `systemctl show`，注入点可测 |
| `apps/fnos-nas-agent/app/capacity-history.mjs` | 磁盘用量的采样历史：去重、封顶、原子落盘、损坏即空 |
| `apps/fnos-nas-agent/app/server.mjs` | 三个新路由 + 审计名 + 采集器装配 |
| `apps/fnos-nas-agent/app/ui/index.html` / `pages.js` | 概览页「服务状态与容量趋势」卡片、文件页「批量重命名」卡片 |
| `tests/phase-191-runtime-wiring.test.mjs` | 9 例：采样语义、采集器 argv、白名单、UI 元素 |
| `tests/phase-191-http-routes.test.mjs` | 1 例真 HTTP 全链路：401/200/405/409/400/403 |

## 接口

### `GET /api/system/services`

- 只读；登录态必需；`GET` 之外返回 405。
- unit 名单固定在服务端常量 `FNOS_SERVICE_UNITS`（12 个，2026-10-24 在 fnOS 1.2 上
  实测存在），**请求方不能指定要查哪个 unit**，否则这个接口就成了读任意系统对象的口子。
- 采集器：`createSystemctlCollector()`，`execFile("systemctl", ["show", unit, "-p", ...])`，
  无 shell、无第二个子命令、unit 先过 `validateUnitName()`、单条 4 秒超时、输出上限 16 KiB。
- 设 `FNOS_AGENT_SERVICE_COLLECTOR=off` 可以完全关掉采集：此时每条都是
  `verdict: "unknown"` + `note: "no-collector"`，**不会**被写成 running。

### `GET /api/system/capacity-forecast?horizonDays=30`

- 只读 + 采样：每次调用读一次系统快照的存储段，并把磁盘用量作为一条采样写进
  `capacity-history.json`（同小时不重复记，最多 720 条，写入走临时文件 + rename）。
- 返回每块磁盘的趋势结论（`buildTrendVerdict`），样本不足时只报当前用量、不给预测；
  响应里的 `sampling` 说明这次有没有新增采样点、为什么没有。
- `horizonDays` 被夹到 1–365，非法值回落 30。

### `POST /api/files/rename-plan` 与 `POST /api/files/rename-apply`

- `rename-plan` 只规划：调用 `planBatchRename(entries, rule, { maxEntries: 50 })`，
  不改任何文件，可以反复预览。
- `rename-apply` 必须带 `confirm: true`（防止误触），并通过执行策略的 `write` 闸门；
  计划本身有冲突（`ok !== true`）时直接 409，**一个文件都不动**。
- 执行时逐条调用 `fileManager.operate({ action: "rename", path, name })`，任何一步失败
  由 `applyBatchRenamePlan` 逆序回滚已成功的项；回滚失败逐条返回，绝不静默。
- 批量上限 50 条：一次改太多既看不清计划，也让回滚窗口变大。

## 安全边界

1. **采集器只有一条命令形状**：`systemctl show <白名单 unit> -p <固定属性>`，没有 shell，
   没有用户提供的二进制路径，没有第二个子命令。
2. **名单在服务端**：请求体里的 `units` 不会被采纳；改名单要改代码，并留下 diff。
3. **测不到就是 unknown**：没有采集器、采集失败、输出不可解析、unit 名非法，四种情况
   都各自带 `note`，`running` 只在真的读到 `active` + `running` 时才给。
4. **改名先计划后执行**：计划的冲突判定（红线 / noop / 计划内重复 / 同目录已存在）在
   执行前完成；执行侧只接受 `ok === true` 的计划对象，不做「边改边判断」。
5. **失败可回滚**：`applied` 是正向成功次数，`rolledBack` 是回滚成功数，
   `rollbackFailures` 逐条列出回滚失败的项。

## 测试

```
node --test tests/phase-191-runtime-wiring.test.mjs   → 9 pass / 0 fail
node --test tests/phase-191-http-routes.test.mjs      → 1 pass / 0 fail（真 HTTP，采集器关闭）
```

## 遗留

- 采集器默认开启，但本机没有 `systemctl`（Windows 开发机）时每条都会是
  `collector-failed`；这是如实上报，不是缺陷。上机验证应在 fnOS 上做。
- 容量趋势的采样频率跟着「有没有人打开页面」走，没人看就没有点；需要固定节奏可以另配
  定时采样，但按「不装常驻机制」的偏好暂不做。
- 批量重命名目前只对「当前目录一层」生效，不递归；递归改名会把回滚窗口放大到不可控。

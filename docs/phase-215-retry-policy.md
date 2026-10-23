# Phase 215：只读步骤的失败重试

## 背景

工作流的每一步都通过 `invokeTool` 交给服务端执行。以前只要有一次抖动——`ECONNRESET`、`ETIMEDOUT`、上游 503——整个工作流就停在 `failed`，让人重跑一遍。而「重跑一遍」这件事，机器自己就能判断该不该做。

这一阶段加了一层很薄的判定：**什么错误值得重试、什么操作允许重试、最多试几次**。

## 三条硬规则

1. **只重试只读动作。** 工具的风险等级来自工具注册表（`read-only` / `write` / `destructive`）。写与破坏性动作失败后必须让人看见，绝不能被悄悄重放。
2. **认不出的错误不重试。** 只有明确的瞬时特征（超时、连接重置/拒绝、`EAI_AGAIN`、429/502/503/504、`5xx`）才重试；`policy-denied`、`unauthorized`、`forbidden`、`invalid`、`not found`、被取消/中止一律不重试。
3. **上限是硬的。** 调用方可以传 `retryAttempts`，但会被夹在 `1..3`（`MAX_RETRY_ATTEMPTS`）。默认 1 次，即不重试。

## API

`app/retry-policy.mjs`（纯函数 + 一个有界包装器，零 I/O）：

| 导出 | 作用 |
| --- | --- |
| `describeFailure(error)` | 收敛成 `{message(≤200), code, status, name}`，不透传原始对象 |
| `classifyFailure(error)` | `kind ∈ transient / permanent / unknown` + `reason` |
| `computeBackoff(attempt, {baseDelayMs, maxDelayMs})` | 指数退避并夹到上限（默认 250ms 起、4s 封顶） |
| `decideRetry({attempt, maxAttempts, risk, failure})` | 只返回 `{retry, delayMs, reason, kind}`，理由可审计 |
| `createRetryingInvoker({invoke, resolveRisk, maxAttempts, sleep, onRetry})` | `run(request)` 返回 `{value, attempts, retried}`，`retries()` 给出重试记录 |

`describeFailure` 里刻意只保留 200 字符的消息与错误码：重试记录要能进日志，就不能带着请求体。

## 接线

`apps/fnos-nas-agent/app/server.mjs` 的 `POST /api/workflows`：

- 读 `retryAttempts`（缺省 1，夹到 `1..3`）；
- `resolveRisk` 查 `toolRegistry.get(tool)?.risk`，查不到（例如刚装上的 MCP 工具还没登记）就视为不可重试；
- `invokeTool: (request) => retryInvoker.run(request)`，重试发生在引擎之外，引擎看到的仍然是「成功」或「最终失败」；
- 响应里多两个字段：`retryAttempts`（本次上限）与 `retries`（`[{tool, attempt, nextAttempt, delayMs, reason}]`）。

引擎本身不改：它依旧在工具报错时把步骤标记为 `failed`，`workflow.finished` 事件照旧上报最终状态。

## 界面

运维页（诊断与运维）里每个内置工作流后面多了「试运行」按钮：

- 内置工作流只用只读工具，所以可以安全地直接跑；
- 请求固定带 `retryAttempts: 2`（只读步骤最多重试 1 次）；
- 结果区列出每一步的 `status`、失败原因，以及每一条重试记录（工具、第几次、原因、等待毫秒）；没有重试时明说「没有发生重试」；
- 全部 `textContent`，不拼 HTML；工作流 id 先过 `WORKFLOW_ID_PATTERN` 白名单。

需要审批的步骤仍会在引擎里被拒绝（`工作流不自行批准任何步骤`），这一点没有变。

## 测试

新增 `tests/phase-215-retry-policy.test.mjs`，14 例全通过：

- 瞬时特征（消息 / 错误码）、HTTP 状态分档、永久信号（策略拒绝、认证、参数、取消）、未知错误；
- `describeFailure` 截断到 200 字符、能从 `cause.code` 取值；
- 退避指数增长与封顶；
- `decideRetry` 的五种拒绝理由与唯一放行路径；
- 上限无法被抬高；
- 包装器：一次成功不睡眠、瞬时失败重试一次并记录、写工具只调用一次、永久失败不重试、未知风险不重试、记录是拷贝、缺少 `invoke` 抛错；
- 接线断言：`retryAttempts` 夹取、`resolveRisk` 查风险、`invokeTool` 走包装器、响应带 `retries`、旧的直调写法已消失；
- 界面断言：结果容器、id 白名单、`retryAttempts: 2`、不拼 HTML。

## 遗留

- 任务级（`task-manager`）与 Agent 计划级（`agent-core.executePlan`）还没有重试：它们的失败语义更重，需要先定义「哪些步骤可重放、重放后如何记账」。
- 没有跨进程的重试队列，进程重启后正在等待的重试会丢。

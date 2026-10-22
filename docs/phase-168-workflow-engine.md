# Phase 168 · 工作流引擎

## 1. 背景

Marvis 迁移工具清单里的 **W02–W08、W10**（多步编排、依赖编排、审批节点、通知目标、并发互斥等）此前在本仓库只有一个种子形态——"健康检查计划"，没有任何编排基础设施：

- 没有依赖图：多步任务只能靠调用方自己按顺序手工串联，前置步骤失败后后继仍会被触发。
- 没有锁：同一个编排被重复触发时会并发执行写操作，互为踩踏。
- 没有通知目标：步骤状态变化没有出口，运维只能翻日志。
- 没有审批节点语义：危险步骤无法在编排层被"卡住"，且容易出现"引擎自批"的越权实现。

本阶段提供一个**纯逻辑、可注入依赖、不执行任何 shell** 的工作流引擎，把上述四件事下沉为一个确定性的、可单测的模块。

对应清单条目：

| 清单编号 | 能力 | 本阶段落地 |
| --- | --- | --- |
| W02 | 多步编排 | `registerWorkflow` + 拓扑序执行 |
| W03 | 步骤依赖 | `dependsOn` + 环检测 + 依赖未完成则跳过 |
| W04 | 审批节点 | `approval: true` + `requestApproval` 注入，引擎不自批 |
| W05 | 失败传播 | 失败步骤的后继标记 `skipped` |
| W06 | 并发互斥 | 同 `workflowId` 单实例运行锁 |
| W07 | 通知目标 | `notify: true` 步骤触发通知回调 |
| W08 | 事件流 | `workflowEvents(id)` 有界事件列表 |
| W10 | 工具白名单 | `allowedTools` + `tool-not-allowed` 跳过 |

## 2. 变更边界

本阶段**只新增 3 个文件**，不修改任何既有文件：

- `apps/fnos-nas-agent/app/workflow-engine.mjs`（新建，579 行）
- `tests/phase-168-workflow-engine.test.mjs`（新建，23 个用例）
- `docs/phase-168-workflow-engine.md`（新建，本文件）

明确**没有**做的事：

- 没有改动 `server.mjs`、`README.md`、`docs/README.md`、`ui/pages.js`——接线与文档索引由 lead 统一处理。
- 没有引入任何第三方依赖，只用 Node 内置能力，且引擎本体不做 I/O。
- 没有 git commit / push。

## 3. 导出 API

```js
import {
  createWorkflowEngine,
  normalizeWorkflowDefinition,
  topologicalOrder
} from "./apps/fnos-nas-agent/app/workflow-engine.mjs";
```

### 3.1 `createWorkflowEngine(options?)`

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `now` | `() => number \| string \| Date` | `() => Date.now()` | 时钟注入点，用于事件时间戳与步骤耗时 |
| `id` | `() => string` | `wf-<base36>-<n>` | 运行实例 id 注入点 |
| `allowedTools` | `string[] \| null` | `null` | 工具白名单；为 `null` 时不额外限制 |

返回引擎实例：

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `registerWorkflow` | `(definition) => WorkflowDefinition` | 注册并校验工作流，非法定义直接抛错 |
| `runWorkflow` | `(workflowId, options?) => Promise<object>` | 按依赖顺序执行 |
| `listWorkflows` | `() => Array<{id, name, stepCount}>` | 列出已注册工作流 |
| `getWorkflow` | `(workflowId) => WorkflowDefinition \| null` | 读取单个工作流定义 |
| `workflowEvents` | `(workflowId) => object[]` | 读取事件流（最多 200 条） |

### 3.2 工作流定义

```js
{
  id: "health-check",
  name: "健康检查",
  steps: [
    { id: "collect", tool: "collect-metrics" },
    { id: "analyze", tool: "analyze", dependsOn: ["collect"] },
    { id: "apply", tool: "remediate", dependsOn: ["analyze"], approval: true, notify: true }
  ]
}
```

step 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | 步骤唯一标识，同一工作流内不得重复 |
| `tool` | `string`（可选） | 交给调用方 `invokeTool` 的工具名 |
| `dependsOn` | `string[]`（可选） | 前置步骤 id；必须指向同工作流内已存在的 step |
| `approval` | `boolean`（可选） | 为 `true` 时该步骤必须先通过 `requestApproval` |
| `notify` | `boolean`（可选） | 为 `true` 时该步骤结束会触发通知回调 |
| `args` | `object`（可选） | 透传给 `invokeTool` 的参数，**不会**进入通知 |

### 3.3 `runWorkflow(workflowId, options?)`

`options` 全部为注入依赖，引擎自身不持有任何外部能力：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `invokeTool` | `(request) => unknown` | 实际工具调用入口，由调用方实现 |
| `requestApproval` | `(request) => unknown` | 审批请求入口，由调用方实现并连接真实审批链路 |
| `sessionId` | `string` | 会话标识，透传给 `invokeTool` / `requestApproval` |
| `notify` | `(notification) => void` | 通知回调 |

`invokeTool` 收到的请求形如 `{ tool, stepId, workflowId, sessionId, args }`。

返回：

```js
{
  started: true,
  workflowId: "health-check",
  runId: "wf-abc-1",
  status: "completed" | "partial" | "failed",
  steps: [{ id, status, reason, blockedBy?, durationMs }],
  events: [ /* 事件流副本 */ ]
}
```

未启动时返回 `{ started: false, reason: "unknown-workflow" | "locked", workflowId }`。

`reason` 取值（step 级别）：`approval-denied`、`approval-failed`、`tool-not-allowed`、`invoke-tool-unavailable`、`dependency-failed`、`dependency-skipped`，失败步骤的 `reason` 为被截断的错误消息。

### 3.4 其他导出

- `normalizeWorkflowDefinition(input)`：定义规范化与校验，非法输入抛出可读错误（`workflow id is required`、`requires an id`、`at least one step`、`duplicate step id`、`depends on an unknown step`、`depends on itself`、`dependency cycle`）。
- `topologicalOrder(steps)`：拓扑排序，同层按声明顺序稳定排列。

## 4. 执行语义

### 4.1 注册期校验（全部抛错，不静默降级）

1. 定义必须为对象，且 `id` 非空。
2. 至少有一个步骤，每个步骤必须有 `id`。
3. step id 不得重复。
4. `dependsOn` 必须是数组，且每个依赖都指向已存在的 step；自依赖单独报错。
5. 依赖图不得成环（三色 DFS 检测）。

重复注册同一 `workflowId` 也会抛错，避免定义被静默覆盖。

### 4.2 运行期语义

- **依赖顺序**：按拓扑序遍历，拓扑序同层保持声明顺序，因此同一份定义每次执行顺序完全一致。
- **依赖未完成**：前置步骤 `failed` → 本步 `skipped` + `dependency-failed`；前置步骤 `skipped` → 本步 `skipped` + `dependency-skipped`。两种情况下本步骤的工具都不会被调用。
- **审批**：`approval: true` 的步骤必须先调用 `requestApproval({ stepId, workflowId, sessionId })`。返回值 `true` 或 `{ approved: true }` 才视为批准；返回假值视为 `approval-denied`，请求本身抛错视为 `approval-failed`。**未注入 `requestApproval` 时一律视为未批准**——引擎绝不自行批准。
- **工具白名单**：`allowedTools` 非空时，工具不在名单内的步骤 `skipped` + `tool-not-allowed`；未注入 `invokeTool` 时 `skipped` + `invoke-tool-unavailable`。
- **失败**：工具抛错被记为该步骤 `failed`，错误消息截断到 300 字符；失败步骤的后继按 4.2 规则跳过。
- **工作流状态**：任一步 `failed` → `failed`；否则任一步 `skipped` → `partial`；否则 `completed`。
- **耗时**：每个步骤的 `durationMs` 由注入的 `now()` 差值计算。

### 4.3 并发锁

- 引擎内部维护 `running` 集合。同一 `workflowId` 已在运行时，第二次 `runWorkflow` 立即返回 `{ started: false, reason: "locked" }`，不会排队也不会并发执行。
- 锁在 `try/finally` 中释放：**即使执行过程中抛出未捕获异常，锁也一定被释放**，不会留下永久锁。

### 4.4 通知

- 只有 `notify === true` 的步骤才触发通知。
- 通知参数**只含三个字段**：`{ stepId, status, durationMs }`。步骤参数原文、工具入参、密钥一律不进入通知。
- 通知回调抛错被吞掉，不影响工作流本身的执行结果。

### 4.5 事件流

事件字段：`{ at, workflowId, type, stepId, status, durationMs, message }`。

事件类型包括 `workflow.registered`、`workflow.started`、`step.approved`、`step.approval-denied`、`step.approval-error`、`step.completed`、`step.failed`、`step.skipped`、`workflow.finished`。

事件列表**有界**：每个工作流最多保留 200 条，超出后从头部丢弃最旧的，保留最新 200 条。

## 5. 安全边界

- **引擎不自带审批能力**：审批完全委托给调用方注入的 `requestApproval`。引擎没有任何"默认批准"路径，缺省即拒绝。
- **引擎不执行任何 shell**：全模块不含 `node:child_process` / `execSync` / `spawnSync` / `node:http` / `node:fs`，不 import 第三方包，也不做任何 I/O。工具执行权完全在调用方的 `invokeTool` 里。
- **引擎不持有密钥**：通知与事件中不携带 `args` 原文。
- **可测试性**：时钟（`now`）与运行 id（`id`）都是注入点，测试不需要等待真实时间。
- **纯逻辑**：同一个引擎实例之外不持有全局状态，注册的工作流与事件都在实例内。

## 6. 测试结果

命令：

```
node --test tests/phase-168-workflow-engine.test.mjs
```

结果：**23 tests / 23 pass / 0 fail**。

用例覆盖：

| 覆盖点 | 用例 |
| --- | --- |
| 注册与查询 | 注册返回定义、`listWorkflows`、`getWorkflow`、重复注册抛错 |
| 定义校验 | step id 重复、未知依赖、自依赖、三节点成环、非法 `dependsOn`、缺 id / 缺步骤 |
| 依赖语义 | 依赖顺序执行、拓扑序稳定性 |
| 审批 | 未批准跳过并记录原因、后继 `dependency-skipped`、缺 `requestApproval` 绝不自行批准、批准后执行 |
| 并发锁 | 第二次调用返回 `locked`、工具失败后锁释放、内部异常后锁释放 |
| 失败传播 | 失败步骤 `failed`、后继 `dependency-failed` |
| 通知 | 仅 `notify` 步骤触发、通知键恰为 `{durationMs,status,stepId}`、通知不含密钥、通知抛错不影响结果 |
| 事件流 | 事件有界 ≤200、超限保留最新 200 条、含 `workflow.started` / `workflow.finished` |
| 其他 | 未知 workflow、工具白名单外跳过、源码断言无第三方 import 且无命令执行/I/O、两次运行顺序一致 |

## 7. 遗留限制

1. **无持久化**：注册的工作流与事件只存在于引擎实例内存中，进程重启即丢失。持久化由上层负责。
2. **无重试/超时**：工具失败直接判 `failed`，不做自动重试；超时需要调用方在 `invokeTool` 内部自行实现。
3. **锁是进程内锁**：只能防同一引擎实例内的并发，不覆盖多进程/多副本部署。
4. **不支持并行分支**：同层步骤严格串行执行，未实现并行扇出。
5. **不支持动态依赖**：依赖关系只能在注册时静态声明。
6. **事件上限 200 条**：长工作流会丢失早期事件，当前只保留尾部。
7. **审批语义依赖调用方**：`requestApproval` 返回 `{approved: true}` 之外的任何真值对象都不算批准，调用方需按此契约实现。
8. **未接线**：本阶段未接入 `server.mjs`，也未登记 `docs/README.md` 索引，二者由 lead 统一处理。

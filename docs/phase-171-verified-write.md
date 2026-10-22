# Phase 171 — 可验证写路径框架

## 背景

Marvis 对照表中的 D08–D11（一次性修复、修复前检查、修复后验证、失败回滚）与
C07–C10（服务 / 容器 / 配置 / 资源写路径）长期是 Open 状态。原因是仓库刻意不提供
未经复核的写路径：一条能改机器状态的接口如果没有预演、审批、读回校验与回滚，
它就是一条不可审计的写路径。

本阶段补的不是一个真实的服务控制接口，而是**「写路径必须长什么样」的框架与契约**。
框架只负责语义与顺序，所有真实副作用（预演、执行、校验、回滚）都由调用方注入。
后续每条写路径（重启服务、改配置、写资源等）只要复用这套语义，就能自动获得
D08–D11 与 C07–C10 要求的全部行为。

约束：

- 纯逻辑，不做任何真实 I/O：不 import `node:child_process` / `node:http` / `node:fs`；
- 无第三方依赖，ESM 风格与仓库既有模块（`workflow-engine.mjs`、`tool-registry.mjs`）一致；
- 框架自身**绝不批准自己**，也不接受任何「已批准」布尔值绕过审批；
- 事件流是有界元数据通道，不携带 `args` 原文与密钥。

## 四阶段语义

`runAction(actionId, options)` 固定执行四个阶段，顺序不可调换：

| 阶段 | 注入函数 | 语义 | 失败时 |
| --- | --- | --- | --- |
| `preview` | `preview(args, { capability, sessionId, taskId })` | 预演：返回**将要改动的对象与影响面**，并可携带变更前快照 `before` | 预演失败即整条动作终止（`reason: "preview-failed"`），不进入审批与执行 |
| `approval` | `requestApproval({ actionId, title, risk, preview, sessionId, taskId })` | 人工/策略审批 | 拿不到明确批准即终止，`{ applied: false, reason: "approval-denied" }`；审批通道抛错同样按未批准处理 |
| `apply` | `apply(args, { capability })` | 真正执行写操作 | 抛错即触发回滚，`reason: "apply-failed"` |
| `verify` | `verify(args, { before, preview })` | 读回校验：重新读取真实状态并与期望比对 | 判定失败即触发回滚，返回 `{ applied: true, verified: false, rolledBack }` |

阶段之间通过 `result` 传递：`preview` 的输出既进入审批请求的 `preview` 字段，
也作为 `verify` 的 `preview` 上下文；`preview` 里的 `before`（若提供）作为
`verify` / `rollback` 的变更前快照。

`verify` 的返回值支持布尔值、`{ verified: boolean }` 与 `{ ok: boolean }` 三种形态。

## capability 与审批的边界

- **capability** 是服务端下发的能力标识，调用方必须在 `runAction` 时通过
  `options.capability` 传入。缺失即失败（`reason: "capability-missing"`），
  框架不会替调用方猜测能力，也不会使用任何默认 capability。
  提前失败可以避免为一条注定无法执行的写路径去申请审批。
- **审批**的唯一来源是调用方注入的 `requestApproval`。框架只接受 `true` 或
  `{ approved: true }` 两种明确批准形态；`undefined`、`false`、异常一律视为未批准。
- 框架**不读取** `options.approved` / `options.preApproved` / `options.approval`
  之类字段：这些标记会被直接忽略，不能用来绕过审批。
- 未注入 `requestApproval` 与「明确拒绝」等价，同样返回 `approval-denied`。
- `risk` 只能是 `"write"` 或 `"destructive"`，在 `defineAction` 时校验，其余值直接抛错。

## 失败与回滚路径

`rollback(args, { before, error })` 是可选注入的回滚函数，在两种情况下被调用：

1. `apply` 抛错 —— 写操作可能只完成了一部分，必须回滚；
2. `verify` 判定失败 —— 写操作虽然"成功返回"，但读回状态不对，同样必须回滚。

回滚结果如实上报，不吞错：

- 回滚成功 → `rolledBack: true`，`rollbackFailed: false`；
- 回滚本身抛错 → `rolledBack: false`，`rollbackFailed: true`，
  `result.rollbackError` 记录 `rollback-failed` 类别；
- 动作未定义 `rollback` → `rolledBack: false`，`rollbackFailed: false`
  （`result` 中不含 `rollbackError`）。

主要失败原因与 `reason` 取值：

| reason | 含义 | applied | verified |
| --- | --- | --- | --- |
| `unknown-action` | 动作未注册 | false | false |
| `capability-missing` | 调用方未提供服务端 capability | false | false |
| `preview-failed` | 预演失败 | false | false |
| `approval-denied` | 未获明确批准（含审批通道异常） | false | false |
| `apply-failed` | 执行抛错（已尝试回滚） | false | false |
| `verify-failed` | 读回校验不通过（已尝试回滚） | true | false |

成功时 `status: "completed"`、`applied: true`、`verified: true`、`reason: null`。

## 事件记录

每个阶段都会产生一条事件，事件流全局有界（最多 200 条，超出时丢弃最旧的一条）。
单条事件只有四个字段：

```json
{ "stage": "apply", "status": "ok", "durationMs": 12, "errorCategory": null }
```

- `stage`：`preview` / `approval` / `apply` / `verify`，以及失败路径上的 `rollback`；
- `status`：`ok` / `failed` / `denied`；
- `durationMs`：该阶段耗时（由注入的 `now` 时钟测量）；
- `errorCategory`：错误类别（`preview-failed`、`approval-denied`、
  `capability-missing`、`apply-failed`、`verify-failed`、`rollback-failed`、
  `approval-failed`、`unknown-action`），没有错误时为 `null`。

事件**不包含** `args` 原文、预览内容、密钥或任何业务负载；`args` 只传给注入的函数。

## 导出 API

```js
import { createVerifiedWritePipeline, VERIFIED_WRITE_STAGES } from "./verified-write.mjs";

const pipeline = createVerifiedWritePipeline({ now, id });

pipeline.defineAction({
  id: "restart-service",
  title: "重启服务",
  risk: "write",                       // "write" | "destructive"
  preview: async (args, { capability }) => ({ before: { running: true }, impact: ["service-a"] }),
  apply: async (args, { capability }) => ({ restarted: true }),
  verify: async (args, { before, preview }) => true,
  rollback: async (args, { before, error }) => { /* 恢复 before */ }
});

const result = await pipeline.runAction("restart-service", {
  requestApproval: async ({ actionId, title, risk, preview }) => true,
  sessionId: "session-1",
  taskId: "task-1",
  capability: "service.restart",       // 必须由服务端传入
  args: { unit: "service-a" }
});

pipeline.getEvents();     // 有界事件流副本
pipeline.listActions();   // 已注册的写路径标识
```

`createVerifiedWritePipeline({ now, id })`：

- `now`：时钟注入，返回毫秒数（number / string / Date 均可），用于计算阶段耗时；
- `id`：运行标识注入，返回字符串；默认生成 `vwp-<base36>-<counter>`。

`runAction` 的返回对象：`runId`、`actionId`、`title`、`risk`、`status`、`reason`、
`applied`、`verified`、`rolledBack`、`rollbackFailed`、`preview`、`capability`、
`sessionId`、`taskId`、`error`、`rollbackError`、`events`。

## 测试结果

`node --test tests/phase-171-verified-write.test.mjs`

- **15 tests / 15 pass / 0 fail**

覆盖用例：

1. 四阶段按 `preview → approval → apply → verify` 固定顺序执行；
2. 预演失败时整条动作终止（不进入审批与执行）；
3. 审批未获明确批准时终止并返回 `approval-denied`；
4. 没有注入审批通道时同样终止（框架不自行批准）；
5. 传入的 `approved` / `preApproved` / `approval` 布尔值不能绕过审批；
6. 缺少 `capability` 时失败且不执行写操作；
7. `verify` 判定失败触发回滚并如实上报；
8. `apply` 抛错触发回滚；
9. 回滚本身失败时如实上报 `rollbackFailed`；
10. 事件流有界，最多 200 条；
11. 事件不包含 `args` 原文或密钥（字段集合固定为 4 个）；
12. `defineAction` 校验风险等级与必需阶段；
13. 审批通道抛错按未批准处理；
14. 未注册的写路径不会执行任何阶段；
15. 模块保持纯逻辑（不引入 `node:child_process` / `node:http` / `node:fs`）。

## 遗留限制

- **尚未接入任何真实写路径**：本阶段只提供框架与契约，没有任何服务 / 容器 /
  配置 / 资源的真实控制接口，`verified-write.mjs` 不执行任何 I/O。
- **审批策略不在框架内**：`requestApproval` 需要调用方实现（可以是同步布尔、
  策略函数或异步人工审批通道）。框架不判断风险等级该如何审批，只做"批准与否"的判定。
- **回滚是调用方责任**：框架只负责在失败路径上调用 `rollback` 并如实上报结果，
  不保证回滚一定能成功，也不重试。
- **`args` 原样透传**：框架不校验 `args` 的形状，各写路径需自行约束参数。
- **`before` 快照依赖预演**：如果 `preview` 不返回 `before`，`verify` 与 `rollback`
  收到的 `before` 就是整个预演结果本身。
- 事件流是进程内的有界元数据通道，**没有持久化**，进程重启后不保留。

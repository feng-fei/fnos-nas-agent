# Phase 209：技能组合（纯函数层）

## 1. 背景

对应 Marvis 清单中的三项能力：

- **SK04 技能组合**：`docs/marvis-capability-matrix.md:318` 仍为 `Open`，既没有组合模型，也没有组合校验。
- **W15 工作流复用**：`docs/marvis-capability-matrix.md:231` 为 `Partly`，现状是 Phase 169 的 runbook 可以复用，但 workflow 本身不能作为模板复用。workflow 步骤用 `tool` 寻址，而非技能。
- **SK06 技能权限声明**：`docs/marvis-capability-matrix.md:320` 为 `Partly`，已有 manifest 声明与逐工具风险，但组合层没有"声明权限 / 实际所需权限"的合并规则。

仓库里"技能"和"工作流"两块其实都存在，只是彼此不相连：

| 现有模块 | 现状 | 与组合的缺口 |
| --- | --- | --- |
| `apps/fnos-nas-agent/app/skill-manifest.mjs` | 从 ZIP 内的 `SKILL.md` frontmatter 解析 `name` / `description` | 只有展示元数据，没有输入契约、权限等级 |
| `apps/fnos-nas-agent/app/skills.mjs` | 技能包记录与 `pending_review → approved → enabled` 状态机 | 记录里没有 `permission` / `requiredInputs` 字段，不能直接回答"这一步需要什么权限" |
| `apps/fnos-nas-agent/app/workflow-engine.mjs` | 定义、拓扑排序、`runWorkflow()` 执行，步骤字段是 `{ id, name, tool, dependsOn, approval, notify, args }` | 步骤按 `tool` 执行，没有 `skillId` 概念；`topologicalOrder()` 遇到环直接抛错，不返回可诊断的 cycle；也没有按条件跳过步骤的语义 |

Phase 209 只做**纯函数层**：把"多个技能如何组成一条可复用流水线"变成一份可校验、可排序、可计划的普通对象，并给出权限合并规则。HTTP 路由、UI、真正交给 `workflow-engine` 执行都不在本阶段（见第 10 节）。

安全约束：不修改任何已有文件；不执行 git；模块本身零 `import`、零 I/O、零 shell；所有函数都不修改入参。

## 2. 新增文件

| 文件 | 内容 |
| --- | --- |
| `apps/fnos-nas-agent/app/skill-composition.mjs` | 新增。组合归一化、校验、拓扑排序、运行计划、权限合并。 |
| `tests/phase-209-skill-composition.test.mjs` | 新增。34 个用例。 |
| `docs/phase-209-skill-composition.md` | 新增。本文件。 |

未修改 `skill-manifest.mjs`、`skills.mjs`、`workflow-engine.mjs`、`server.mjs`、`docs/README.md` 等任何已有文件。

## 3. 导出 API

模块路径：`apps/fnos-nas-agent/app/skill-composition.mjs`。

| 导出 | 说明 |
| --- | --- |
| `MAX_COMPOSITION_STEPS` | `20`。单个组合的最大步骤数；超过时归一化直接拒绝，不静默截断。 |
| `MAX_COMPOSITION_DEPTH` | `3`。依赖链最大边数；超过只产生 warning，不阻塞。 |
| `PERMISSION_LEVELS` | 冻结数组 `["read-only", "write", "destructive"]`，由低到高。 |
| `normalizeComposition(input)` | `=> { ok: true, composition } \| { ok: false, reason }`，纯函数。 |
| `validateComposition(composition, { skills = [] } = {})` | `=> { ok, errors, warnings }`，错误码固定为七类。 |
| `topologicalOrder(composition)` | `=> { order, cycle }`；成环时返回 cycle，不抛错。 |
| `planCompositionRun(composition, { resolveSkill, facts } = {})` | `=> { runnable, skipped, steps, effectivePermissions }`。 |
| `mergeCompositionPermissions(composition, skillPermissions)` | `=> "read-only" \| "write" \| "destructive"`。 |

## 4. 组合 JSON 结构

```json
{
  "id": "release-pipeline",
  "name": "Release pipeline",
  "description": "Build, test and ship",
  "steps": [
    {
      "id": "build",
      "skillId": "builder",
      "dependsOn": [],
      "inputs": { "target": "nas" }
    },
    {
      "id": "test",
      "skillId": "tester",
      "dependsOn": ["build"],
      "inputs": {},
      "when": { "field": "quality.score", "equals": "high" }
    },
    {
      "id": "ship",
      "skillId": "shipper",
      "dependsOn": ["test"],
      "inputs": {}
    }
  ],
  "permissions": ["read-only", "write"]
}
```

字段约定：

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `id` | string | 组合 id，匹配 `/^[a-z0-9][a-z0-9._-]{0,63}$/`；超长（trim 后 > 64）拒绝，不是截断。 |
| `name` | string | 展示名，trim 后最多 100 字符；为空时回退到 `id`。 |
| `description` | string | 展示描述，trim 后最多 500 字符，可为空。 |
| `steps` | array | 0–20 步。空组合合法。 |
| `steps[].id` | string | 步骤 id，组合内唯一；匹配 `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`（允许大写，便于 `build` / `Build` 这类命名）。 |
| `steps[].skillId` | string | 必须是合法技能 id（小写规则同上 `id`），指向外部技能目录。 |
| `steps[].dependsOn` | string[] | 缺省为 `[]`；必须引用本组合内已声明的步骤 id；去重保序；不得自引用。 |
| `steps[].inputs` | object | 缺省为 `{}`；按值深拷贝。值里可用 `${stepId.path}` 引用上游步骤输出，校验阶段只检查被引用步骤是否存在。 |
| `steps[].when` | object | 可选。`{ field, equals }`；`field` 是事实路径（如 `quality.score`）或 `${stepId.path}`。 |
| `permissions` | string[] | 可选，组合声明自己最多需要的权限；非法/未知等级直接拒绝；去重后按 read-only → write → destructive 排序。 |

`normalizeComposition` 的输出固定为 `{ id, name, description, steps, permissions }`，每个 step 固定为 `{ id, skillId, dependsOn, inputs, when? }`。所有数组和对象都是新引用；输入的 `inputs` / `when.equals` 做深拷贝（循环引用、函数、超过 8 层嵌套一律降级为 `null`），因此可以安全地把归一化结果交给缓存或执行器。

拒绝原因（`reason`）一览：

| 分组 | reason |
| --- | --- |
| 顶层 | `invalid-composition`、`invalid-composition-id`、`invalid-steps`、`too-many-steps`、`invalid-permissions`、`unknown-permission` |
| 步骤 | `invalid-step`、`invalid-step-id`、`duplicate-step`、`invalid-skill-id`、`invalid-dependency`、`invalid-inputs`、`invalid-condition`、`self-dependency`、`unknown-dependency` |

## 5. 七类校验错误

`validateComposition(composition, { skills })` 返回 `{ ok, errors, warnings }`；`errors` 最多 100 条，`warnings` 最多 50 条。`ok === (errors.length === 0)`。

`skills` 是技能目录，元素可以是字符串 id，也可以是对象。对象按 `id` / `skillId` / `name` 建别名；权限读 `permission`（字符串）或 `permissions` / `requiredPermissions`（数组）；`requiredInputs` 支持字符串数组或 `{ name, required !== false }` 数组。没有声明权限的技能按 `read-only` 处理。

| code | 触发条件 | `stepId` |
| --- | --- | --- |
| `unknown-skill` | 步骤的 `skillId` 在传入的 `skills` 目录里找不到；`skillId` 为空也算。 | 该步骤 |
| `dependency-cycle` | `dependsOn` 形成环（含自依赖）。 | 环上的第一个步骤 |
| `dependency-order` | 步骤在数组里的位置早于它依赖的步骤，即前向引用；执行顺序需要倒过来。 | 引用方步骤 |
| `missing-input` | 三种情况：技能声明了 `requiredInputs` 而步骤 `inputs` 未提供；`inputs` 不是普通对象；字符串里出现 `${stepId...}` 但 `stepId` 不在本组合中。 | 该步骤 |
| `permission-escalation` | 组合显式声明了 `permissions`（非空），但某步骤技能所需权限高于声明上限（按 read-only < write < destructive 比较）。 | 越权步骤 |
| `duplicate-step` | 同一 `stepId` 在原始 `composition.steps` 里出现多次。归一化会在更早阶段拒绝重复，这里兜底手写对象。 | 重复的 id |
| `condition-unreachable` | `when` 不是对象、`field` 为空、缺少 `equals`；`${id...}` 指向未知步骤；引用的是已知步骤但不是本步骤的上游依赖；`field` 不是合法事实路径。 | 该步骤 |

补充语义：

- `dependency-order` 不是"排序错了"，而是"声明顺序无法直接顺序执行"。`topologicalOrder()` 仍然能排出正确顺序；这条错误用于阻止调用方按数组顺序直接跑。
- `missing-input` 的 `${stepId...}` 只要求步骤存在，**不强制**它同时出现在 `dependsOn` 中。执行顺序由 `dependsOn` 负责，引用关系只是数据依赖的提示；这一点在遗留中说明。
- `permission-escalation` 只在组合声明了非空 `permissions` 时检查。`permissions: []` 表示"没有声明上限"，不产生该错误；真正的有效权限仍由 `planCompositionRun` / `mergeCompositionPermissions` 取最大值，见第 7 节。
- `condition-unreachable` 不检查事实值是否存在：`quality.score` 在运行时可能由调用方提供，计划期缺失只算条件不满足，不算结构性错误。
- `warnings` 目前只有 `dependency-depth-exceeded`：依赖链边数超过 `MAX_COMPOSITION_DEPTH = 3` 时提示。它不阻塞执行，也不改变 `ok`。

## 6. 拓扑排序与运行计划

### 6.1 `topologicalOrder`

使用 Kahn 算法，同一层内保持步骤在组合中的声明顺序，结果是稳定、可复现的。未知依赖边（不存在的 `stepId`）被忽略，不参与入度；重复 id 只保留第一次出现。

| 情况 | 返回 |
| --- | --- |
| 无环 | `{ order: ["build", "test", "ship"], cycle: null }` |
| 有环 | `{ order: <能排出的部分顺序>, cycle: [{ stepId: "a" }, { stepId: "b" }] }` |

**成环时 `order` 是部分结果，调用方必须先看 `cycle`，不能直接执行 `order`。** 这也是与 `workflow-engine.mjs` 的 `topologicalOrder(steps)` 的差异：后者依赖成环时直接 `throw`，组合层需要可诊断的 cycle 数据。

### 6.2 `planCompositionRun`

签名：

```js
planCompositionRun(composition, {
  resolveSkill = () => null,
  facts = {}
} = {}) => {
  runnable: boolean,
  skipped: Array<{ stepId, reason }>,
  steps: Array<{ stepId, skillId, permission, dependsOn }>,
  effectivePermissions: "read-only" | "write" | "destructive"
}
```

执行计划的生成过程：

1. 按 `topologicalOrder()` 的顺序遍历；成环时整份计划直接不可运行，`skipped` 为每个步骤记一条 `dependency-cycle`，`steps` 为空。
2. 对每个步骤调用一次 `resolveSkill(skillId, stepSnapshot)`。第二个参数是步骤快照（`{ id, skillId, dependsOn, inputs }`，`inputs` 已深拷贝），resolver 可以返回技能对象、字符串 id 或 `null`；抛异常按 `null` 处理（记为 `unknown-skill`，不把异常带出计划层）。
3. 判断跳过原因，**优先级从高到低**：
   - `unknown-dependency`：`dependsOn` 指向组合里不存在的步骤；
   - `dependency-skipped`：任一直接或间接前置步骤被跳过；
   - `condition-not-met`：`when` 条件不满足，或计划期无法求值；
   - `unknown-skill`：resolver 返回空。
4. 没被跳过的步骤按顺序进入 `steps`，并带上技能权限与依赖快照。

`runnable` 的定义是"至少有一个步骤可执行"：空组合、全部跳过、成环都返回 `false`。`skipped` 按拓扑顺序记录，`reason` 是稳定字符串，路由层可以直接映射成提示文案。

`when` 的求值规则：

- `field` 按点路径从 `facts` 读取（`quality.score` → `facts.quality.score`），只读，不修改 `facts`；
- 只有"路径存在且值深度相等"才算满足，数组/普通对象按值比较；`equals` 支持 JSON 值；
- `field` 以 `${...}` 开头表示读取步骤输出。计划期还没有任何步骤执行，**这类条件一律视为不满足**，对应步骤进入 `skipped`，而不是乐观放行；
- `when` 结构非法（缺 `field` / `equals`）时同样按不满足处理。结构错误应该先在 `validateComposition` 里被 `condition-unreachable` 拦住；计划层做保守兜底。

## 7. 权限不得提升

权限等级严格按 `read-only < write < destructive` 排序（`PERMISSION_LEVELS` 的顺序就是比较顺序）。

`mergeCompositionPermissions(composition, skillPermissions)` 的算法：

1. 组合没有步骤 → 直接返回 `"read-only"`（空组合没有实际动作，即使声明了 `destructive`）。
2. 否则收集：组合声明的 `permissions` + 每个步骤技能的权限。
3. 返回其中等级最高的一项。

`skillPermissions` 支持 `Map`、普通对象、技能记录数组、函数；键先按 `skillId` 查找，再按 `stepId` 兜底。缺失的技能按 `read-only` 处理。

**安全红线：组合不得提权。** 只要任何一步需要 `destructive`，整份组合的有效权限就是 `destructive`；组合不能通过声明一个更低的 `permissions` 把破坏性步骤包装成低权限。这条规则写死在 `mergeCompositionPermissions` 上方的源码注释中，并由 `tests/phase-209-skill-composition.test.mjs` 的 "mergeCompositionPermissions never lets a composition understate a destructive step" 与 "planCompositionRun ... destructive" 相关用例锁定。

`planCompositionRun` 的 `effectivePermissions` 同样取最大值，并且有两点刻意为之：

- **包含被条件跳过的步骤**：某步技能是 `destructive`，即使本次运行因 `when` 不满足而跳过，组合的有效权限仍然是 `destructive`。权限描述的是"这份组合可能做什么"，不是"这一次实际做了什么"。
- **组合声明可以更保守地高于技能**：声明 `write`、技能只有 `read-only` 时结果是 `write`；声明永远不能把结果拉低。

声明权限在 `validateComposition` 里的角色是**上限**：声明 `read-only` 却在组合里放了需要 `destructive` 的步骤，会得到 `permission-escalation`。声明为空则不做上限校验，但有效权限仍由合并函数决定，不会因为"没声明"而变低。

## 8. 安全边界

- **纯函数**：模块没有任何 `import`、`require`、`process`、`fetch`、`console`、文件系统或子进程访问，不读环境变量、不写全局状态。测试里有一条源码纯度断言（`the module is pure: no imports, no I/O, no shell, no process access`）。
- **不修改入参**：归一化深拷贝 `inputs` / `when.equals`；校验、排序、计划、权限合并都只读。测试用 `structuredClone` 快照和 `deepFreeze` 双重验证。
- **有界输入**：步骤上限 20；错误上限 100；warning 上限 50；requiredInputs 最多 50 条；引用扫描深度 8；权限只有三个合法值。超限输入在归一化阶段直接拒绝，不做无界解析。
- **不做 shell 拼接**：模块不产生命令、路径或 URL；`skillId` / `stepId` 只作为字符串键使用，不进入 `exec`、`spawn` 或文件路径。
- **不执行任何技能**：`planCompositionRun` 只生成计划，不调用工具、不访问 NAS、不请求审批。真正的执行与审批必须由调用方或 `workflow-engine` 负责。

## 9. 测试结果

执行环境：Windows，Node v22.22.0（仓库 `package.json` 声明 `node >= 26`，本模块未使用 26 专有 API）。

```powershell
node --check apps/fnos-nas-agent/app/skill-composition.mjs
node --test tests/phase-209-skill-composition.test.mjs
```

两条命令均通过。`node --check` 无输出即成功；测试的 TAP 汇总：

```text
1..34
# tests 34
# suites 0
# pass 34
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 272.9045
```

用例分组：

| 分组 | 用例数 | 覆盖点 |
| --- | --- | --- |
| normalize | 10 | 正常归一化、name 回退与 trim、非对象/缺 steps、非法组合 id、非法 step id、非法 skill id、重复/自依赖/未知依赖、inputs/condition/permissions 拒绝、20 与 21 步边界、深拷贝与入参不变 |
| validate | 9 | 合法组合、`unknown-skill`、`dependency-cycle`、`dependency-order`、`missing-input`（requiredInputs 与 `${ghost}` 引用）、`permission-escalation`、`duplicate-step`、`condition-unreachable`、依赖深度 warning |
| topologicalOrder | 2 | 稳定拓扑顺序、成环返回 cycle 而不抛错 |
| planCompositionRun | 6 | 可运行计划与顺序、条件不满足及级联跳过、未知技能、未知依赖、成环全跳过、resolver 抛异常 |
| mergeCompositionPermissions | 3 | 三档权限、跨档升级、空组合 read-only |
| 边界与纯度 | 4 | 空组合全链路不抛错、深冻结输入、源码纯度、常量冻结与数值 |

## 10. 遗留（由 Lead 接线）

1. **HTTP 未接**：`server.mjs` 已有 `/api/skills` 系列路由（约 1249 行起），但没有 `/api/compositions`。建议新开 `/api/compositions`（与 `/api/skills` 平级，语义上是"技能的组合"而不是"技能包"），提供 `GET /api/compositions`、`GET /api/compositions/:id`、`POST /api/compositions/validate`、`POST /api/compositions/:id/plan`；路由层只做 JSON 解析与 `auditRoute()`，校验/计划仍走本模块。若不想新增顶层前缀，也可以挂在 `/api/skills/compositions` 下，但需要避免与 `/api/skills/:id` 的通配路由冲突。
2. **未交给 workflow-engine 执行**：`planCompositionRun().steps` 可以一对一映射成 `workflow-engine.mjs` 的步骤：`{ id: stepId, name: stepId, tool: skillId, dependsOn, approval: permission === "destructive", args: inputs }`，再用 `registerWorkflow()` 注册、`runWorkflow(id, { invokeTool, requestApproval, sessionId })` 执行。缺口是引擎按 `tool` 调用 `invokeTool`，没有 `skillId` 概念；适配层需要把技能 id 解析成真正可执行的 tool，并保证 `invokeTool` 只接受已解析的技能。映射应在计划之后、注册之前完成，绝不能把成环的组合直接交给会抛错的 `normalizeWorkflowDefinition`。
3. **技能目录缺字段**：`skills.mjs` 的技能记录目前没有 `permission`、`requiredInputs` 字段。`validateComposition` / `planCompositionRun` 需要调用方传入带权限的技能目录；在 Phase 209 之后，建议给技能记录补上显式权限声明（SK06），再让 resolver 直接读存储，而不是从 `declaredCapabilities` 猜。
4. **条件只支持事实**：计划期只能读 `facts`；读取步骤输出的 `${stepId...}` 条件在计划期一律视为不满足。若要让"上一步结果决定下一步是否执行"真正生效，执行器需要在每一步完成后重新求值 `when`，并在跳过时级联跳过依赖者；这属于执行层语义，不在本模块。
5. **没有组合持久化**：本阶段没有组合存储（没有 `composition-store.mjs`），组合由调用方在内存中构造。若需要复用，建议按 `runbook-store.mjs` 的原子写约定新增存储，并在归一化后落盘。
6. **输入引用只查存在性**：`${stepId.path}` 只校验 `stepId` 在本组合内，不强制它出现在 `dependsOn` 中；执行器仍应按 `dependsOn` 排序。若后续希望把"数据依赖"也纳入顺序约束，可以在 `validateComposition` 增加一条新的错误码，但会改变七类错误的稳定契约，需要同步文档与测试。
7. **`docs/README.md` 未收录本文档**：按本任务约束不修改已有文件，因此没有在 `docs/README.md` 增加 Phase 209 条目。当前索引止于 Phase 202，Phase 203–208 的文档也尚未收录；全量 `tests/docs-links.test.mjs` 会因这些未收录文档失败。需要 Lead 在合入时统一补索引，而不是由本阶段修改 README。
8. **无 UI**：没有组合编辑器、拓扑视图或计划预览。若后续做 UI，建议直接展示 `validateComposition().errors` 的 `code` / `stepId`，并把 `planCompositionRun().skipped` 渲染成"本次不会执行"的列表。
9. **没有真实执行/审批**：本模块只输出计划与有效权限，不强制审批，也不保证调用方真的按 `effectivePermissions` 行事；执行入口必须自己把 `destructive` 接到审批流程。
10. **Node 版本**：本机为 Node v22.22.0，仓库声明 `node >= 26`；本模块没有使用 26 专有 API，测试在 22 上通过，但 CI 仍以仓库声明为准。

# Phase 206 — 工作流的事件触发判定层

## 背景

任务清单 `docs/marvis-feature-checklist.md` 中，W03「事件触发」仍标记为 **Open**：工作流引擎（`apps/fnos-nas-agent/app/workflow-engine.mjs`，Phase 168）目前只提供依赖图、启动锁与通知钩子，**没有任何触发源**——谁来调用 `engine.runWorkflow(id)`、在什么条件下调用，全部由上层临时决定。

同时 W07「幂等控制」与 W10「通知系统」在事件这一侧也缺一层统一判定：同一个故障事实连续两次轮询到，不能重复拉起工作流，更不能重复推送通知；夜间静默时段不应该告警；工作流已经在跑的时候再次触发只应被记录而不是排队。

本阶段把这三件事收敛成一个**纯函数判定层**：输入是「规则 + 事实 + 当前时间 + 少量状态」，输出是「该触发的列表、被抑制的列表、更新后的状态」。它不采集事实、不启动工作流、不发通知，也不读时钟、不写磁盘——这些仍由接线方（Lead）负责。

```
事件事实（现有路由/采集器）
        │
        ▼
evaluateTriggers(rules, facts, { now, state })   ← Phase 206（本阶段）
        │  fire[] / suppressed[] / state
        ▼
workflow-engine.runWorkflow(workflowId)          ← 已有
        │
        ▼
notificationFor(fired) → 通知渠道（W10 去重后）  ← 已有钩子 + 本阶段的 level/title/body
```

## 新增文件

| 文件 | 作用 |
| --- | --- |
| `apps/fnos-nas-agent/app/workflow-triggers.mjs` | 触发判定模块（零 import 纯函数） |
| `tests/phase-206-workflow-triggers.test.mjs` | 24 个用例，`node:test` |
| `docs/phase-206-workflow-triggers.md` | 本文档 |

未修改任何已有文件，未执行 git 操作。

## 规则模型

### 常量

| 名称 | 值 | 说明 |
| --- | --- | --- |
| `TRIGGER_KINDS` | `["service-down","disk-space-low","smart-warning","thermal-high","job-failed","certificate-expiring"]` | 六类触发源，冻结数组 |
| `MAX_TRIGGERS` | `200` | 单次判定最多评估的规则数，超出截断 |
| `DEFAULT_DEDUPE_WINDOW_MS` | `15 * 60 * 1000` | 默认冷却窗口（15 分钟） |
| `DEFAULT_QUIET_HOURS` | `{ start: "23:00", end: "07:00" }` | 默认静默时段（跨午夜） |

### 规则规格

```js
{
  id: "svc-nginx-down",              // /^[a-z0-9][a-z0-9._-]{0,63}$/
  kind: "service-down",              // 六个之一
  workflowId: "wf-service-restart",  // 必填，指向已存在的工作流
  condition: {                       // 可选；未知键会被拒绝
    threshold: 90,                   // 数值；不同 kind 有默认值与取值范围
    unit: "%",                       // 与 kind 匹配才允许显式给出
    target: "/vol1"                  // 可选前缀过滤：只匹配该前缀的对象
  },
  cooldownMs: 900000,                // 0 .. 24h
  quietHours: { start: "23:00", end: "07:00" },  // 或 "off"
  enabled: true
}
```

`normalizeTriggerRule(input)` 返回 `{ ok: true, rule }` 或 `{ ok: false, reason }`，`rule` 是深冻结的规范化副本，可直接持久化。拒绝原因（`reason`）是稳定字符串，便于上层映射文案：

| reason | 触发条件 |
| --- | --- |
| `invalid-rule` | 输入不是普通对象（null / 数组 / 字符串等） |
| `invalid-id` | id 不满足命名正则（含大写、下划线、超长、空串） |
| `unknown-kind` | kind 不在 `TRIGGER_KINDS` 中 |
| `missing-workflow-id` | workflowId 缺失或全空白 |
| `invalid-workflow-id` | workflowId 超过 128 字符或含控制字符 |
| `invalid-cooldown` | cooldownMs 不是 0..86400000 之间的整数 |
| `invalid-quiet-hours` | quietHours 既不是 `"off"` 也不是合法的 `{start,end}`（HH:MM） |
| `invalid-enabled` | enabled 不是布尔值 |
| `invalid-condition` | condition 非法：未知键、threshold 类型/范围错误、unit 与 kind 不匹配、target 非法 |

`cooldownMs` 允许显式 `0`（表示不冷却）；边界值 `0` 与 `86400000` 都合法。缺省的 `condition` 会被补全为该 kind 的默认阈值（见下表），因此判定代码永远拿到完整的三个字段。

## 六类触发条件与判定语义

| kind | 事实字段 | 默认阈值 | 触发条件 | 级别 |
| --- | --- | --- | --- | --- |
| `service-down` | `services[{name,active}]` | — | `active === false`（严格布尔；未知状态不算故障） | warning |
| `disk-space-low` | `disks[{mount,usedPercent}]` | 90 % | `usedPercent >= threshold` | warning |
| `smart-warning` | `smart[{device,status}]` | — | `status` 为 `"warning"` / `"failing"` / `"failed"` | critical |
| `thermal-high` | `thermal[{zone,celsius}]` | 65 °C | `celsius >= threshold` | critical |
| `job-failed` | `jobs[{id,ok}]` | — | `ok === false` | warning |
| `certificate-expiring` | `certificates[{host,daysRemaining}]` | 30 天 | `daysRemaining <= threshold`（负数/零即已过期） | info |

判定是「候选对象 × 规则」的笛卡尔积：

- 一条规则可以命中多个对象（两个服务同时宕机 → 两条 `fire`，`subject` 分别不同，键互不相同）。
- 同一对象只产生一条 `fire`；`detail` 只含阈值与实测值的数字，例如 `磁盘 /vol1 使用率 95% 已达阈值 90%`，**不包含原始日志**。
- `condition.target` 是**前缀**过滤：`target: "/vol1"` 只匹配挂载点以 `/vol1` 开头的对象（`/vol1`、`/vol1/media` 命中，`/vol2` 不命中）。target 存在但没有任何对象匹配时，该规则不触发、也不进入 suppressed——它没有「违规候选」。
- `threshold` 可以覆盖默认值；等于阈值即触发（`>=` / `<=`），因为「达到阈值」本身就是要报警的点。
- 阈值范围在 `normalizeTriggerRule` 就拒绝：磁盘 0..100，温度 -40..200，证书剩余天数 0..3650；其他 kind 不接受 threshold。

### 「无证据不触发」原则

**事实对象缺字段、数组为空、或者字段存在但类型/状态不可识别时，一律视为「没有证据」，不触发。** 这是本模块最重要的语义，代码注释与实现都按这条写死：

- 没给 `disks`，不等于「磁盘都健康」，而是「不知道」→ 磁盘规则返回 `no-facts`，不产生 `fire`。
- `services: [{name:"nginx"}]`（缺 `active`）、`active: "false"`（字符串）、`usedPercent: "95"`（字符串）、`status: "unknown"`、`celsius: null`、`ok` 缺失——全部不触发。宁可漏报，也不让类型错误造成误报。
- 事实数组里的 `null`、数字等畸形条目被跳过，其余合法条目照常判定。
- `facts` 整体不是普通对象（null / 数组 / 字符串）时同样按无证据处理，**不抛异常**。

这条原则的直接后果：判定层永远不应该把「没采到数据」翻译成「一切正常」，也不应该翻译成「全部故障」。上层接线后若希望「N 分钟无事实就告警」，那属于告警链路（W10），不是触发层。

## 冷却与静默时段

### 判定顺序

对每条启用的规则，依次短路：

1. `disabled` — `enabled === false`，只记录 `{ ruleId, reason: "disabled" }`。
2. `no-facts` — 该 kind 对应的事实源缺失/为空。
3. `already-running` — `state.running` 里已有该 `workflowId`（避免重复拉起正在跑的工作流）。
4. `quiet-hours` — 当前时刻落在静默窗口内。**静默抑制只拦通知，不拦事实判定**：命中对象在窗口内被标记为 `quiet-hours`，不会进入 `fire`，因此不会启动工作流；窗口结束后的下一次判定（`cooldownMs` 也允许的话）会正常触发。
5. `cooldown` — 同一 `dedupeKey` 上次触发时刻距今 `< cooldownMs`。严格小于：窗口恰好结束的那一刻恢复触发。

通过全部检查的候选进入 `fire`，并刷新 `state.lastFiredAt[dedupeKey] = now`。

`suppressed` 只记录**本该触发但被拦下**的对象；规则启用、事实健康、没有任何对象越界时，既不进 `fire` 也不进 `suppressed`——「健康」不是一种抑制。

### 冷却键

`dedupeKey(rule, fact)` 返回 `${rule.id}:${subject}`。规则 id 的字符集不含 `:`，所以键无歧义；空 subject 归一为 `"unknown"`；非法 rule id 归一为 `unknown`（防御性，正常流程不应出现）。

冷却状态由调用方持久化。`state` 形状：

```js
{
  lastFiredAt: { "svc-nginx-down:nginx": 1736942400000 },
  running: ["wf-service-restart"]   // 也接受 Set / { id: true } 形态
}
```

输出状态是**新对象**，并且会裁剪掉「已经不在当前规则集里的 key」，避免规则删除后无限增长（上限 `MAX_STATE_ENTRIES = 4096`，按时间戳保留最新）。输入状态不会被修改；被冷却拦下的判定也不会刷新时间戳。

### 静默时段

`quietHoursActive(quietHours, nowDate)`：

- 按**宿主本地时间**解释（`getHours()/getMinutes()`），与 Phase 168 引擎的本地时钟口径一致；跨时区部署需要调用方自行换算 `now`。
- `start > end` 视为跨午夜窗口：`[start, 24:00) ∪ [00:00, end)`，两端包含起点、不含终点（`23:00–07:00` 在 23:00 与 06:59 为静默，07:00 解除）。
- `start === end` 视为**空窗口**（不静默），否则「23:00–23:00」会退化成全天静默，几乎肯定是配置笔误。
- `quietHours === "off"` 或规格非法 → 返回 `false`（不静默，交给 normalize 报错）。

## 时间处理

`now` 必须由调用方传入（毫秒数、Date、或实现 `getTime()` 的对象）。**模块内部没有 `Date.now()`，也没有 `new Date()` 无参调用**：

- 未传、或传入不可解析的时间 → 不触发任何规则，返回 `notes: ["now-missing"]`，状态照原样透传。这样「时钟没准备好」不会退化成「用当前时间误触发」。
- 显式传 `now: 0` 是可信时钟（epoch 0），照常判定，不算缺失。测试里用 2026-01-15 的本地时刻构造 `Date`，因此不依赖运行机器的时区。

返回值：

```js
{
  fire: [{ ruleId, workflowId, kind, subject, detail, dedupeKey }],
  suppressed: [{ ruleId, reason }],           // cooldown 时可能附带 subject/dedupeKey
  state: { lastFiredAt: {...}, running: [...] },
  truncated: false,                            // 规则数 > MAX_TRIGGERS
  notes: []                                    // "now-missing" / "rules-truncated" / "rules-invalid" / "invalid-rule:<i>:<reason>"
}
```

规则数组超过 `MAX_TRIGGERS` 时只取前 200 条，`truncated: true` 且 `notes` 带 `rules-truncated`；非法规则被跳过并在 `notes` 里留 `invalid-rule:<index>:<reason>`，一条坏规则不会让整批判定失败。

## 通知去重

`notificationFor(fired)` 只接收 `fire` 里的一条记录，产出 `{ level, title, body }`：

- `level` 由 kind 决定（见六类表）：`critical` 用于 SMART 与温度，`warning` 用于服务/磁盘/任务，`info` 用于证书到期提醒；未知 kind 保守降到 `info`。
- `title` 是简短中文结论（如「服务异常」「SMART 告警」）。
- `body` 只包含「对象标签 + 实测值/阈值 + 建议动作」：不引用 `detail` 里的原始日志，不拼接日志行，也不出现文件路径。对象名会做 `safeLabel` 处理（取最后一段：`/dev/sda → sda`、`/vol1 → vol1`、`/ → 未知对象`），并折叠换行/控制字符，保证正文单行、无 `/` 与 `\`。
- 去重键与工作流冷却共用 `dedupeKey`：同一对象在冷却窗口内只会被通知一次；W10 侧若还要做更长的通知合并，可直接用 `dedupeKey` 作为幂等键。

## 测试结果

```text
node --check apps/fnos-nas-agent/app/workflow-triggers.mjs
# 退出码 0，无输出

node --test tests/phase-206-workflow-triggers.test.mjs
# tests 24
# suites 0
# pass 24
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

24 个用例覆盖：常量与边界值、规则规范化（含 19 组拒绝输入：非法 id / 未知 kind / 缺 workflowId / cooldown 越界与小数 / quietHours 非法 / enabled 类型错 / condition 未知键与越界 / 非对象输入）、六类 kind 各触发一次、阈值覆盖与等值触发、缺事实不触发（含部分缺失）、类型错误不触发、facts 非对象不抛错、冷却窗口抑制与窗口结束恢复、`cooldownMs: 0`、默认静默时段跨午夜两侧、`quietHoursActive` 边界（起点/终点/跨午夜/off/等长窗口/NaN）、`already-running`（数组/Set/映射三种形态）、disabled、`now` 缺失不触发且 epoch 0 照常触发、`MAX_TRIGGERS` 截断与恰好 200 条、一条规则多个对象、`target` 前缀过滤、level 映射与未知 kind、通知正文无路径/无日志/无换行、`dedupeKey` 稳定性与归一化、入参深度冻结前后 `JSON` 快照相等、状态裁剪、源码纯度（零 import、无 `Date.now()`、无无参 `new Date()`、无定时器/网络/文件 I/O、不碰 `process`）。测试文件自身用 `deepFreeze` 冻结输入，模块一旦尝试改写就会在严格模式下抛错。

## 遗留（由 Lead 接线）

1. **事件事实采集与定时轮询不在本阶段**。`facts` 的字段名已按现有路由对齐：`/api/system/services`、`/api/system/smart`、`/api/system/thermal`、`/api/system/capacity-forecast`、`/api/network/certificate-check`、`/api/tasks`；六类事实的采集/映射应放在这些路由已有的缓存或采集器旁边，本模块只做判定。
2. **调用点建议**：在 `server.mjs` 的轮询/定时任务里（已有 5–60s 的采集节奏），把上一轮采集结果 + 持久化的 `state` 喂给 `evaluateTriggers`；对每条 `fire` 先查 `engine.runWorkflow(workflowId)` 的 `{ started, reason }`，`started === false` 且 `reason === "locked"` 时不必再通知。`fire` 已在判定层做过冷却与静默过滤，引擎层不需要重复。
3. **状态持久化**：`state.lastFiredAt` 与 `running` 建议与工作流快照（Phase 168 的持久化机制）同库同事务写入，避免重启后冷却窗口丢失导致重复通知。
4. **`docs/README.md` 索引**：`tests/docs-links.test.mjs` 要求 `docs/README.md` 列出 `docs/` 下每一个文档。按本阶段「不修改已有文件」的红线，索引条目留给 Lead 补（在 202 之后追加一行 Phase 206）。在此之前跑全量 `node --test`，`docs-links` 会出现 1 个预期失败，属已知且刻意留下的接线缺口，不是本模块缺陷。
5. **告警升级与通知渠道**：`notificationFor` 只负责单条消息的 level/title/body；聚合、升级、渠道分发仍归 W10 的通知子系统。

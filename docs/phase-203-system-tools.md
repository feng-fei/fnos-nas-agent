# Phase 203 - 系统只读工具定义模块

## 背景

HTTP 侧已经把这些只读事实暴露成路由（`/api/system/services`、`/api/system/thermal`、`/api/system/events`、`/api/system/smart`、`/api/system/snapshot`、`/api/system/capabilities`、`/api/system/capacity-forecast`），按 Phase 200 的口径统计共有 66 条路由；而 Agent 真正能调到的工具只有 18 个（`read-only-tools.mjs` 注册表里被 `agent-core.mjs` 看见的那部分）。结果是同一份事实有两套入口：Web 面板能看到，Agent 在排查"服务为什么挂了 / 盘是不是要满了"时却只能回一句"请去面板查看"。

Phase 203 只解决"定义"这一半：把七个已经存在、且只读的系统事实，写成 Agent 可直接调用的工具定义（id / 标题 / 描述 / 风险等级 / 入参 schema / invoke），采集逻辑全部通过依赖注入传入，模块本身不碰任何 I/O。注册表接线不在本阶段（见"遗留"）。

口径说明：本阶段沿用 Lead 立项时"66 条 HTTP 路由 / Agent 18 个工具"的统计口径；按当前代码实测，`server.mjs` 的 `auditRoute` 能识别 84 个不同路由 id，`read-only-tools.mjs` 的 `definitions` 数组为 50 条。两者差异来自统计时机与"面向 Agent 暴露"与"HTTP 可访问"的口径不同，本阶段不重新裁定，接线时以实测为准。

## 新增或变更代码

| 文件 | 变化 |
| --- | --- |
| `apps/fnos-nas-agent/app/system-tools.mjs` | 新增。七个只读工具的定义工厂 + 入参校验 + 统一结果封装 + 敏感键清洗。 |
| `tests/phase-203-system-tools.test.mjs` | 新增。18 个用例锁死 id/risk、缺采集器、采集器失败、透传、入参拦截、清洗与源码红线。 |
| `docs/phase-203-system-tools.md` | 新增。本文件。 |

未修改任何已有文件。`read-only-tools.mjs`、`server.mjs`、`agent-core.mjs` 均保持原样。

## 模块导出

| 导出 | 类型 | 说明 |
| --- | --- | --- |
| `createSystemToolDefinitions(injection?)` | `(object?) => ToolDefinition[]` | 主入口。入参是七个采集器的注入口，缺省全为 `null`；返回 7 个定义，顺序固定。 |
| `listSystemTools()` | `() => { id, title, risk }[]` | 只要摘要、不带函数，可直接 `JSON.stringify`（供 `tools.list()` 序列化用）。 |
| `validateToolArguments(id, args?)` | `(string, object?) => { ok, errors }` | 校验器可单独复用，`invoke` 内部走的就是它，保证两处结论一致。 |
| `SYSTEM_TOOL_IDS` | `readonly string[]` | 七个 id 的冻结清单，顺序与定义数组一致。 |
| `READ_ONLY_RISK` / `REDACTED_PLACEHOLDER` | `string` | `"read-only"` / `"<redacted>"`。 |
| `SENSITIVE_KEY_PATTERN` | `RegExp` | `/pass|token|secret|key/i`，清洗规则。 |
| `MAX_COLLECTOR_MESSAGE_LENGTH` | `number` | `200`，失败信息上限。 |
| `MAX_REDACTION_DEPTH` | `number` | `12`，清洗递归深度上限。 |
| `DEFAULT_EVENTS_LIMIT` / `MAX_EVENTS_LIMIT` / `MAX_EVENTS_SINCE_LENGTH` | `number` | `20` / `200` / `40`。 |
| `DEFAULT_FORECAST_HORIZON_DAYS` / `MAX_FORECAST_HORIZON_DAYS` | `number` | `30` / `365`。 |

定义对象形状（与 `read-only-tools.mjs` 现有条目同构，便于直接合并进注册表）：

```js
{
  id: "events.recent",
  title: "最近系统事件",
  description: "...（给模型看的一句话，含"只读""失败会明确报错"约定）",
  risk: "read-only",
  inputSchema: { type: "object", properties: {...}, additionalProperties: false },
  invoke: async (args) => ({ ok: true, data: ... })
}
```

`inputSchema` 只使用仓库既有子集：`type` / `properties` / `required` / `additionalProperties` / `minLength` / `maxLength` / `enum` / `minimum` / `maximum`。

## 七个工具的入参 / 返回契约

所有工具的统一返回约定：

- 成功：`{ ok: true, data }`，`data` 为采集器返回值（经敏感键清洗），采集器返回 `null` 时如实 `data: null`，不伪造成健康。
- 未注入采集器（缺省 `null` 或注入的不是函数）：`{ ok: false, reason: "collector-unavailable", id }`，不抛异常。
- 采集器抛错（同步或异步）：`{ ok: false, reason: "collector-failed", id, message }`，`message` 压成单行并截断到 200 字符。
- 入参非法：`{ ok: false, reason: "invalid-arguments", id, errors }`，校验发生在采集器之前，非法入参不会触达采集器。

### 1. `services.list` — 系统服务状态

- 入参：无（`{ type: "object", properties: {}, additionalProperties: false }`）。
- 采集器：`services()`。
- 典型 data：`{ profile, units: [{ unit, load, active, sub, description }] }`（形状由采集器决定，本模块原样透传，不校验）。

### 2. `smart.summary` — 硬盘 SMART 健康

- 入参：无。
- 采集器：`smart()`。
- 典型 data：`{ devices: [{ device, text }], notes }`（`smartctl` 原始文本由上层摘要，本模块不打码设备名）。

### 3. `thermal.status` — 温度状态

- 入参：无。
- 采集器：`thermal()`。
- 典型 data：`{ sensors: [...], verdict }`；读不到温度时约定返回 `null`，Agent 侧据此回答"未知"而不是"正常"。

### 4. `events.recent` — 最近系统事件

- 入参：

```js
{
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 200 },
    since: { type: "string", minLength: 1, maxLength: 40 },
    level: { type: "string", enum: ["emerg","alert","crit","err","warning","notice","info","debug"] }
  },
  additionalProperties: false
}
```

- 采集器：`events({ limit, since?, level? })`；`limit` 缺省 20，`since` / `level` 不给就不传键。
- 典型 data：`{ verdict, counts, repeated, notes }`（`summarizeEvents` 的输出）。
- 与 HTTP 路由的差异：HTTP 侧 `limit` 钳到 1..50，本模块上限给到 200，由采集器自己决定是否再钳；`level` 枚举复用 `system-events.mjs` 的 `EVENT_LEVELS`，不接受 `fatal` / `warn` 这类别名。

### 5. `snapshot.summary` — 系统快照摘要

- 入参：无。
- 采集器：`snapshot()`。
- 典型 data：`{ verdict, sections: [{ id, status }] }`，`status` 取值受 `system-snapshot.mjs` 的 `SECTION_STATUSES` 约束。
- 备注：路由 `/api/system/snapshot` 支持 `?sections=cpu,storage` 过滤。本阶段工具不带该参数，因为 Agent 需要的是"整体是否健康"这一判断，按段拉取会诱导它用多次调用拼结论；确有需要再加 `sections` 数组参数，schema 里补 `items` 与 `maxItems`。

### 6. `capabilities.get` — 设备能力体检

- 入参：无。
- 采集器：`capabilities()`。
- 典型 data：`{ profile, checks: [{ id, status, detail }] }`。

### 7. `capacity.forecast` — 容量趋势预测

- 入参：

```js
{
  type: "object",
  properties: { horizonDays: { type: "integer", minimum: 1, maximum: 365 } },
  additionalProperties: false
}
```

- 采集器：`forecast({ horizonDays })`；缺省 30，与 `capacity-forecast.mjs` 的 `DEFAULT_HORIZON_DAYS` 一致。
- 典型 data：`{ currentUsedBytes, currentTotalBytes, usedPercent, projectedUsedBytes, projectedUsedPercent, daysUntilFull, confidence, assumptions, reason }`。

成功与失败样例：

```json
{ "ok": true, "data": { "verdict": "ok", "counts": { "err": 0 }, "repeated": [], "notes": [] } }
```

```json
{ "ok": false, "reason": "collector-unavailable", "id": "smart.summary" }
```

```json
{ "ok": false, "reason": "collector-failed", "id": "services.list", "message": "Command failed: systemctl show -p Id fnos.service（已截断）" }
```

```json
{ "ok": false, "reason": "invalid-arguments", "id": "events.recent", "errors": ["above-maximum: limit needs <= 200"] }
```

## 安全边界

1. 模块是只读查询的适配器：不做任何文件 / 网络 / 进程 I/O，除 `./system-events.mjs`（纯函数、零 import）外不 import 任何模块，不拼接命令，也不向采集器传 shell 字符串以外的第二套执行路径——执行能力完全由注入的采集器持有。
2. 七个工具 `risk` 全部为 `"read-only"`，不进入 `read-only-tools.mjs` 的破坏性能力分支；即使模型编造参数，最坏结果也只是"查了一次"。
3. 入参白名单：`additionalProperties: false` 且默认 schema 为 `{}`，五个无参数工具对任何多余键直接 `invalid-arguments`；`limit` / `horizonDays` 必须是整数且落在边界内，`since` 限长 40，`level` 只接受 syslog 八级。
4. 返回值清洗：递归遍历采集器返回的对象，键名匹配 `/pass|token|secret|key/i` 的值替换为 `"<redacted>"`；数组元素同样清洗；循环引用输出 `"[circular]"`，超过 12 层输出 `"[depth-limit]"`；非普通对象（`Date` / `Map` / `Buffer` 等）原样放行，避免把二进制打碎。规则故意做钝——`monkey` / `keyword` / `passengerCount` 会被误伤，这是"宁可多打码"的取舍。
5. 有界性：采集器失败信息先压成单行（控制字符替换为空格）、再按 Unicode 码点截到 200；清洗有深度上限；因此一次工具调用不会把异常堆栈或超长文本灌进模型上下文。
6. 不掩盖失败：缺采集器报 `collector-unavailable`，采集器报错报 `collector-failed`，采集器返回 `null` 就 `data: null`。模块自己不编造"看起来正常"的结论。
7. 原始数据不被污染：清洗产出新对象，调用方（采集器）手里的原对象保持原值，便于同一份数据既进日志又进模型上下文。

## 测试结果

`node --check apps/fnos-nas-agent/app/system-tools.mjs` 通过。

```
node --test tests/phase-203-system-tools.test.mjs

# tests 18
# suites 0
# pass 18
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 197.0085
```

覆盖点：7 个 id 与顺序固定、risk 全为 read-only（1）；定义结构完整（2）；无采集器时七个全部 `collector-unavailable` 且不抛（3）；注入非函数同样按缺失处理（4）；同步抛错截断到 200（5）；异步拒绝、字符串与非 Error 抛出值被压成单行（6）；同步透传（7）；异步透传（8）；`null` 如实返回（9）；`limit` 边界 200 放行、201/0/-1/1.5/"20"/NaN/Infinity 拒绝且不触达采集器（10）；`events.recent` 只转发真实给出的条件、默认 `limit: 20`、`since` 40/41 边界、`level` 别名拒绝（11）；`horizonDays` 默认 30、越界与字符串拒绝（12）；无参工具拒绝多余键、`undefined` 值视为未传（13）；敏感键名（含嵌套与数组内）替换为 `<redacted>` 且不改写原始对象（14）；循环引用与 40 层嵌套不抛（15）；`listSystemTools` 可 `JSON.stringify` 往返（16）；`validateToolArguments` 与 `invoke` 结论一致（17）；源码只 import `./system-events.mjs`、不含 `node:` 内建导入（18）。

## 遗留（由 Lead 接线）

1. 尚未注册进 `read-only-tools.mjs` 注册表，Agent 目前仍看不见这七个工具。
   - 接线建议：在 `read-only-tools.mjs` 的 `definitions` 数组拼装处合并 `createSystemToolDefinitions({ services, smart, thermal, events, snapshot, capabilities, forecast })` 的返回值，并在 `invoke(id, args, options)` 的分发链最前面加一条系统工具分支（命中就 `return`，未命中继续走原逻辑）；若不想动该文件的 400 行分发链，更省事的做法是在 `server.mjs:505` 的 `createToolRegistry` 桥接层包一层——`list` 返回 `[...readOnlyTools.list(), ...listSystemTools()]`，`invoke` 先查系统工具再回退 `readOnlyTools.invoke(...)`。此时代码注释与授权/审计口径需要一并覆盖这七个 id。
2. 采集器还没接到真实命令上：`services` 需要 `createSystemctlCollector`，`smart` 需要 `createSmartctlCollector`，`thermal` 需要读传感器的实现，`events` 需要日志读取 + `summarizeEvents`，`snapshot` 需要 `buildSystemSnapshot` 的组装，`capabilities` 需要 `evaluateDeviceCapabilities`，`forecast` 需要 `forecastCapacity`。这些都在本模块之外，注入即可。
3. 执行策略与审计：`read-only-tools.mjs` 的 `executionPolicy` 目前对未知 id 的处理方式尚未确认；接入后应确认这七个 id 是否需要在 `auditRoute` 之外单独记一条审计，以及是否需要按工具级别做速率限制（`events.recent` 上限 200 已经给了，但连续调用仍可能形成压力）。
4. `snapshot.summary` 未暴露 `sections` 过滤参数，`events.recent` 上限取 200 与 HTTP 侧的 50 不一致——这两处是有意为之，等真实 Agent 使用数据回来再决定是否收窄。

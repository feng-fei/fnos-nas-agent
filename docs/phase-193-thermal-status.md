# Phase 193 — 温度读数规范化与分级

## 1. 背景

真机上的温度来源很杂，采集层拿到的往往是下面这样的东西：

```text
cpu   = 45000        （毫摄氏度，sysfs/hwmon 的典型单位）
board = 52           （摄氏度，另一个采集器直接给了度数）
nvme  = ""           （传感器存在，但这次读不到）
```

同一份数据里混着两种单位、空值、以及可能重复上报的传感器。直接把这些字符串丢给 UI
或者 `Number()`，会得到两种最坏的结果：**把 45000 当成 45000℃** 或者**把空值当成 0℃**，
两者都会让「温度」这个结论彻底失真。

本阶段只补「拿到原始读数之后怎么判」这一层，全部是纯函数：

- 把 `"45000"` / `45000` / `"45000\n"` 变成可信的摄氏度；
- 按来源去重、按温度降序排列、把脏数据挑出来留痕；
- 用固定阈值给出 `cool / normal / warm / hot` 分级与 `ok / warm / hot / unknown` 结论。

**本阶段不读取任何温度节点、不执行任何命令、不做 I/O。** 采集器由 Lead 接线时注入，
注入方式就是把采集到的数字数组交给 `normalizeThermalReadings(list)`。

- 模块：`apps/fnos-nas-agent/app/thermal-status.mjs`（ESM，零依赖，零 `import`）
- 测试：`tests/phase-193-thermal-status.test.mjs`（node:test，28 个用例）
- 自验：`node --check apps/fnos-nas-agent/app/thermal-status.mjs`、
  `node --check tests/phase-193-thermal-status.test.mjs`、
  `node --test tests/phase-193-thermal-status.test.mjs`

## 2. 导出 API 与字段

### `THERMAL_CLASSES`

```js
Object.freeze(["cool", "normal", "warm", "hot", "unknown"])
```

单项分级取值。`unknown` 表示「无法归类」，**不代表 0℃**；它保留在枚举里是为了让下游
能表达「温度未知」而不用借用 `null` 或 `0`。正常路径（读数先经过
`normalizeThermalReadings`）不会产出 `unknown`，非法读数在规范化阶段就进了 `dropped`。

### `parseMilliCelsius(value)` → `number | null`

把一个**毫摄氏度**读数（字符串或数字）解析成摄氏度：

| 输入 | 输出 | 说明 |
| --- | --- | --- |
| `"45000"` | `45` | 字符串按毫摄氏度解释 |
| `"45000\n"` | `45` | 先 `trim()`，sysfs 常带换行 |
| `" 45000\t"` | `45` | 首尾空白允许 |
| `45000` | `45` | 数字输入同样按毫摄氏度解释 |
| `"-5000"` | `-5` | 允许负温 |
| `"0"` / `0` | `0` | `0` 是合法读数，不是「没有读数」 |
| `"-0"` | `0` | 归一掉 `-0` |
| `""`、`"   "`、`"abc"`、`"NaN"`、`null`、`undefined`、`{}`、`true` | `null` | 空 / 非数字 / 非字符串 |
| `NaN`、`Infinity`、`-Infinity` | `null` | 非有限数 |
| `"200000"` / `"-200000"` | `200` / `-200` | 边界**含** ±200℃ |
| `"200001"` / `"-200001"` | `null` | 超出 ±200℃，不做截断 |
| `"1e3"`、`"0x10"`、`"45,000"`、`"45 000"`、`"45°C"`、`"45."` | `null` | 无约定的格式一律拒绝 |

只接受 `^[+-]?\d+(?:\.\d+)?$`（先 `trim()`）。最终摄氏度还必须落在
`[-200, 200]` 闭区间内，超出即 `null`。

### `normalizeThermalReadings(list)` → `{ readings, dropped, notes }`

输入元素形状：

```js
{ source: "cpu", label?: "CPU 封装", raw: "45000", unit: "milliCelsius" | "celsius" }
```

输出：

```js
{
  readings: [{ source: "cpu", label: "CPU 封装", celsius: 45 }],
  dropped:  [{ source: "hdd", reason: "bad-raw" }],
  notes:    ["duplicate-source:cpu", "dropped:hdd:bad-raw"]
}
```

- `readings`：每条 `{ source, label, celsius }`，按 `celsius` **降序**；温度相同的保持输入先后
  （依赖 `Array#sort` 的稳定排序）。
- `dropped`：`[{ source, reason }]`，`reason` ∈ `DROP_REASONS`
  （`not-object` / `missing-source` / `bad-unit` / `bad-raw`）。来源本身无法识别时
  `source` 为 `null`。
- `notes`：
  - `duplicate-source:<source>`：同源重复，每个来源只记一条；
  - `dropped:<source|#序号>:<reason>`：`#序号` 是入参数组的 1-based 位置，
    只在来源不可识别时使用；完全相同的 note 只保留一条。
- `unit` 只接受 `"milliCelsius"` 与 `"celsius"` 两个字面量，**大小写不同也算非法**
  （`"MilliCelsius"` → `bad-unit`），不做自动换算或猜测。
- `label` 缺省为 `null`：本层不用 `source` 冒充 label；要不要回退由展示层决定。
- 非数组入参抛 `TypeError`。

### `summarizeThermals(input, { warnC = 65, criticalC = 80 })` → `{ verdict, counts, hottest, notes }`

`input` 可以是 `readings` 数组，也可以直接是 `normalizeThermalReadings()` 的返回值
（自动取其中的 `readings`）；其他形状抛 `TypeError`。规范化阶段的 `notes` **不会**合并进来，
两段信息各自负责（见第 5 节）。

```js
{
  verdict: "warm",                                   // ok | warm | hot | unknown
  counts: { total: 3, cool: 0, normal: 2, warm: 1, hot: 0 },
  hottest: { source: "gpu", label: "GPU", celsius: 78 },
  notes: []
}
```

- `counts.total` 是**可归类读数**的条数，恒等于 `cool + normal + warm + hot`；
  非法条目计入 `notes`（`invalid-reading: ...`），不计入 `total`。
- `hottest`：最高温读数；并列时取输入顺序中最先出现的一条；一条可归类读数都没有时为 `null`。
- `verdict`：有 `hot` → `hot`；否则有 `warm` → `warm`；否则有可归类读数 → `ok`；
  一条都没有 → `unknown`（`hottest` 同时为 `null`）。
- `notes`：空输入 / 全部不可归类时含 `no-readings`；存在非法条目时含
  `invalid-reading: <id 列表>`（`id` 优先取 `source`，否则 `#<1-based 位置>`）。

### 其他导出常量

`DEFAULT_WARN_C`（65）、`DEFAULT_CRITICAL_C`（80）、`COOL_BELOW_C`（5）、
`MAX_ABSOLUTE_CELSIUS`（200）、`RAW_UNITS`、`THERMAL_VERDICTS`、`DROP_REASONS`。

## 3. 语义与安全边界

### 3.1 「不猜」原则

这一层最重要的约束是**不猜**，具体落到四处：

1. **不猜单位。** `unit` 缺失或拼错就是 `bad-unit`，不会「默认按毫摄氏度算」；否则
   `52` 会被当成 `0.052℃`（若误判为毫）或 `45000` 会被当成 `45000℃`（若误判为度），
   两种错都足以让告警失效。
2. **不猜来源。** `source` 必须是非空字符串，缺了就是 `missing-source`，不会拿
   `sensor-1` 之类的编号顶上；否则去重和「同源取最高温」都会建立在假 ID 上。
3. **不猜阈值。** `warnC` / `criticalC` 非法（非数字、`NaN`、`Infinity`、`warnC >= criticalC`）
   一律抛 `TypeError`，绝不静默回落到默认值。配置写错了却继续跑，比直接报错危险得多。
4. **不猜温度。** 空输入或全部不可归类时，结论是 `unknown` + `hottest: null`，
   **绝不返回 0℃** 假装测到了；`0` 只有在调用方真的传了 `0`（或 `"0"`）时才会出现。

### 3.2 分级与结论

每个可归类读数按固定阈值归类（默认 `warnC = 65`、`criticalC = 80`）：

| 条件 | 分级 |
| --- | --- |
| `celsius >= criticalC` | `hot` |
| `celsius >= warnC` | `warm` |
| `celsius < 5` | `cool` |
| 其余 | `normal` |

- 边界值属于更高一档：`65` 是 `warm`，`80` 是 `hot`，`5` 是 `normal`，
  `4.999` 是 `cool`。
- `cool` 只在「低于 `warnC` 且低于 5℃」时出现。若调用方把 `warnC` 调到 5 以下，
  `cool` 桶将不再出现（例如 `warnC = 0` 时，`4℃` 属于 `warm`）。这是固定阈值规则的
  直接结果，不是 bug。
- 结论与单项分级是两套枚举：`ok` 表示「没有 warm 也没有 hot」，它不属于
  `THERMAL_CLASSES`；`unknown` 表示「一条可归类读数都没有」。
- 阈值只校验「是有限数且 `warnC < criticalC`」，**不限制取值范围**（例如允许
  `warnC = -50`）。非法范围不在本层臆断。

### 3.3 去重、排序与留痕

- 同一 `source` 出现多次时，只保留 `celsius` 最高的一条，并在 `notes` 记
  `duplicate-source:<source>`（每个来源一条，不重复刷屏）。
- 保留的是**最高温那条读数自身**的 `label`，不跨条目拼装（避免把 A 条的 label 贴到
  B 条的温度上）。
- 去重只在合法读数之间进行：先被丢弃的条目不会让后一条合法的同源读数变成「重复」，
  避免把「坏数据 + 好数据」误报成 `duplicate-source`。
- 重复与丢弃都会留痕：`notes` 里的信息不会因为结果「看起来正常」而被静默吞掉。
- 单条脏数据不会中断整个规范化，合法读数照常输出。

### 3.4 异常与边界

- 可信温度上限 ±200℃（含边界）：超出视为脏数据（`parseMilliCelsius` 返回 `null`，
  `normalizeThermalReadings` 记 `bad-raw`，`summarizeThermals` 记 `invalid-reading`）。
  这是「传感器读数合理性」防线，不是业务阈值。
- `summarizeThermals` 只接受 `number` 型且落在 ±200℃ 内的 `celsius`；字符串 `"45"`、
  `NaN`、`null` 都按非法条目处理并留痕，不做 `Number()` 强转——强转就是一种猜测。
- 非数组的原始列表、非数组也非 `{ readings: [...] }` 的汇总入参，都抛 `TypeError`。
- `null` / `undefined` 作为 `options` 时使用默认阈值；数组、数字、字符串、函数作为
  `options` 时抛 `TypeError`。

### 3.5 纯函数边界

- 模块源码**没有任何 `import`**，也不含 `require(`、`node:fs`、`node:child_process`、
  `node:http`、`node:net`、`node:dns`、`node:os`、`node:path`；测试里有一条用例静态断言。
- 不读 `/sys/class/thermal`、不读 hwmon、不执行 `sensors`、不发 HTTP。
  采集属于接线层，本层只处理调用方交进来的数字。
- 不修改入参：`readings` / `dropped` / `notes` 都是新对象，`counts`、`hottest` 同理。

## 4. 测试结果

```text
node --test tests/phase-193-thermal-status.test.mjs

# tests 28
# pass 28
# fail 0
```

Node v22.22.0，Windows 本机执行，无真机、无网络调用。覆盖点：

- `parseMilliCelsius`：字符串 / 数字 / 换行 / 空白 / `+` 号 / 负温 / `0` / 小数 / `-0`
  归一；空、非数字、非有限、非字符串标量；科学计数法、十六进制、千分位、`45°C`
  等歧义格式；±200℃ 的闭区间边界与超界；超长数字串。
- `normalizeThermalReadings`：两种单位混排并按摄氏度降序；同源去重取最高温
  （先低后高、先高后低两种顺序）；同源 3 条只记一条 note；`not-object` /
  `missing-source` / `bad-unit` / `bad-raw` 四类丢弃；丢弃项不制造 `duplicate-source`；
  `label` 缺省 `null`、非字符串 label 退化为 `null`、label 首尾空白 trim；同温稳定排序；
  空列表；非数组抛 `TypeError`。
- `summarizeThermals`：空输入 → `unknown` + `hottest: null` + `no-readings`；
  全非法输入 → `unknown` 且不出现 0℃；`5` / `65` / `80` 及 `4.999` / `64.999` / `79.999`
  的精确边界；混合读数的计数、`hottest` 与 `warm` 结论；`ok` 结论；
  直接吃 `normalizeThermalReadings` 返回值且不合并其 notes；自定义阈值；
  默认阈值 65/80；10 组非法阈值与非对象 options 抛 `TypeError`；
  非法入参形状抛 `TypeError`；最高温并列取第一条；`total` 恒等于四桶之和。
- 安全边界：源码无 `import` / `require(` / 运行时 I/O 模块引用 / `execSync` / `spawnSync`。

## 5. 遗留

1. **`docs/README.md` 未登记（本阶段限制）。** 任务约束「只允许新建三个文件」，
   因此没有把本文档加进 `docs/README.md`。仓库既有的 `tests/docs-links.test.mjs`
   要求「docs/README.md lists every document in docs/」，所以**全量 `node --test` 会因此失败**；
   接线时需要向 `docs/README.md` 的 Phase 193 段落补一条
   `[Phase 193 — Thermal status](phase-193-thermal-status.md)` 链接。
2. **真实采集器未接线。** 本层没有任何温度来源；Lead 需要在采集层把
   hwmon / thermal zone / `sensors` 的输出映射成 `{ source, label?, raw, unit }`。
   映射时**必须显式给出 `unit`**，本层不会替采集器猜单位。
   现成的 `apps/fnos-nas-agent/app/thermal-collector.mjs`（Phase 196）返回的是
   `{ readings: [{ source, label, raw, unit: "milliCelsius" }], notes }`，接线应写成
   `normalizeThermalReadings(collected.readings)`，采集器自己的 `notes` 由路由层保留；
   不要把它整个塞给 `summarizeThermals`——原始项没有 `celsius`，会被记成
   `invalid-reading` 并得到 `unknown`，虽然不会伪造温度，但结论是错的。
3. **阈值 65℃ / 80℃ 只是默认值，未经真机标定。** 它们不是 fnOS 的官方阈值，也
   没有按具体机型、盘位或环境温度校准。接线后建议先用真实数据观察分布，再决定
   是否按设备覆盖；覆盖入口就是 `summarizeThermals` 的 `warnC` / `criticalC`。
4. **规范化 notes 与汇总 notes 不合并。** 若 UI 只展示 `summarizeThermals` 的结果，
   调用方需要同时把 `normalizeThermalReadings` 的 `dropped` / `notes`（例如「有 2 条
   读数被丢弃」）呈现出来，否则脏数据会被静默忽略。
5. **`cool` 桶在低 `warnC` 下不可达。** 若后续希望「低于 5℃ 一律 cool」，需要把
   `classifyCelsius` 里 `cool` 判定提到 `warm` 之前，这是一处明确的行为变更，
   测试需要同步调整。
6. **未提供 `parseCelsius` 的公开导出。** 摄氏度单位目前只经 `normalizeThermalReadings`
   进入系统；如果接线层需要单独解析摄氏度原始值，可再导出对应的纯函数。

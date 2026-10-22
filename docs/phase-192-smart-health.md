# Phase 192 — SMART 盘健康解析层（纯函数）

- 模块：`apps/fnos-nas-agent/app/smart-health.mjs`
- 测试：`tests/phase-192-smart-health.test.mjs`
- 自验：`node --test tests/phase-192-smart-health.test.mjs`

## 1. 背景

能力矩阵里的 **S06（磁盘健康 / SMART）** 此前仍是 Open。仓库里与 SMART 有关的东西只有
`system-snapshot.mjs`（phase 161）里那个「没有 SMART 支持就只能是未知」的状态位，以及
TRIM CLI 侧对人读输出的描述；**没有任何一层把 `smartctl` 的文本变成结构化字段和可解释
结论**。结果是：真机输出的三处坑没有人处理，阈值与判断散落在 UI / service 里，也没法单测。

本阶段只补这一层纯函数，边界刻意收窄：

- 不执行 `smartctl`、不读设备节点、不判权限、不做超时；这些属于采集层，由 Lead 后续注入；
- 不引入任何第三方依赖，不引用任何外部模块（零 I/O），可以直接被采集层、HTTP 层、测试复用；
- 不新增「猜」的能力：拿不到、读不懂、不认识，一律如实表现为 `null` / `unknown` / `note`。

真机文本里最容易被解析器骗过的几处，正是本层要正面处理的：

1. **`SMART support is:` 会出现两行**。ATA 盘常见
   `Available - device has SMART capability.` 紧跟 `Enabled`，朴素的「键值对覆盖」会把
   `Enabled` 当成最终答案；而 `Disabled` 表示设备有 SMART 但被关掉、属性根本读不到。
2. **NVMe 的 `-A` 文本不是 ATA 属性表**。它输出的是 `SMART/Health Information` 的键值行，
   没有 `ID# ATTRIBUTE_NAME ...` 表格，硬套 ATA 属性 ID 会得出完全错误的结论。
3. **`RAW_VALUE` 不是纯数字**。`44 (0 18 0 0 0)`、`1,234`、`---` 都真实存在，
   把它当整数强转要么截断要么抛错。

对应到实现，规则全部写成导出常量（`TEMPERATURE_WARNING_CELSIUS`、`MEDIA_ERROR_ATTRIBUTE_IDS`、
`REQUIRED_ATTRIBUTE_IDS`……），审查时先看常量再看代码。

## 2. 导出 API 与字段

### 2.1 `parseSmartInfo(text)`

解析 `smartctl -i` 风格（按 `标签: 值` 行）文本，只认白名单标签，返回值字段顺序固定：

| 字段 | 类型 | 来源标签 | 说明 |
| --- | --- | --- | --- |
| `modelFamily` | `string \| null` | `Model Family` | 厂商系列，缺失即 `null`，**不回填** `model` |
| `model` | `string \| null` | `Device Model`（ATA）或 `Model Number`（NVMe） | 型号原文 |
| `serialNumber` | `string \| null` | `Serial Number` | 序列号 |
| `firmwareVersion` | `string \| null` | `Firmware Version` | 固件版本 |
| `rotationRate` | `string \| null` | `Rotation Rate` | **保留原文**：`7200 rpm` / `Solid State Device` |
| `powerOnHours` | `number \| null` | `Power On Hours` | 去掉千分位逗号后必须是纯整数，否则 `null` |
| `smartSupport` | `"available" \| "unavailable" \| null` | `SMART support is`（可多行） | 见 3.2 的合并规则 |
| `parsed` | `boolean` | — | 元信息：文本里是否至少出现过一个白名单标签的非空值 |

`parsed` 不属于白名单字段，是给上层判断「这份文本到底解析没解析出东西」用的：
空文本、非字符串、只有 banner 的文本都是 `parsed: false` + 全字段 `null`。

`powerOnHours` 虽然名字来自 `-i`，但解析按标签匹配，NVMe 的 `smartctl -A`
（`SMART/Health Information` 段）里同样一行 `Power On Hours: 1,234` 也能取到；
`smartctl -i` 本身没有这一行时就是 `null`，不从 `-A` 的属性 9 去凑。

### 2.2 `parseSmartAttributes(text)`

解析 `smartctl -A` 的 ATA 属性表，返回按输出顺序排列的数组：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `number` | 1–255，越界视为不可解析 |
| `name` | `string` | 列名原文（如 `Reallocated_Sector_Ct`） |
| `value` | `number` | `VALUE` 列，0–255 |
| `worst` | `number` | `WORST` 列，0–255 |
| `threshold` | `number` | `THRESH` 列，0–255（`010` → `10`） |
| `raw` | `string` | `RAW_VALUE` **原文**，不做数字转换 |
| `whenFailed` | `string \| null` | `-` → `null`，其余保留原文（如 `FAILING_NOW`、`In_the_past`） |

行必须至少 10 个 token，且列位固定：
`ID# NAME FLAG VALUE WORST THRESH TYPE UPDATED WHEN_FAILED RAW...`。
表头（含 `ATTRIBUTE_NAME` 的行）、`=== ... ===` 分节线、banner、空行直接忽略；
**行首是最多三位数字、但列位/取值不合法的「数据样」行会被跳过并计数**。

计数通过数组上一个**不可枚举**的 `skipped` 属性暴露：

```js
const rows = parseSmartAttributes(text);
rows.length;    // 成功解析的属性行数
rows.skipped;   // 被跳过的数据样行数
```

不可枚举是刻意的：数组在 `deepEqual`、`JSON.stringify`、`[...rows]` 里仍然是一个纯数组，
不会因为多带一个属性而让调用方的契约比较失败；需要计数时直接读 `rows.skipped`
（注意先 spread 会丢掉它）。

### 2.3 `summarizeSmartHealth({ info, attributes })`

| 输出 | 形状 |
| --- | --- |
| `verdict` | `"ok" \| "warning" \| "failed" \| "unknown"` |
| `findings` | `Array<{ code, severity, attributeId, detail }>`，按属性 id 升序稳定排序 |
| `notes` | `string[]`，形如 `missing-attribute:197`，去重且顺序稳定 |

- `code` / `severity` 来自导出常量，取值固定（`SMART_FINDING_CODES` / `SMART_SEVERITIES`）；
- `attributeId` 恒为触发规则的属性 id（本层的所有 finding 都能落到具体属性）；
- `detail` 是中文人读解释，包含证据（`raw=8`、`when_failed=FAILING_NOW`），长度有上限。

### 2.4 导出的判定常量

| 常量 | 值 / 含义 |
| --- | --- |
| `SMART_SUPPORT` | `{ AVAILABLE: "available", UNAVAILABLE: "unavailable" }` |
| `SMART_VERDICTS` | `ok / warning / failed / unknown` |
| `VERDICT_PRECEDENCE` | `["failed", "warning", "unknown", "ok"]`，见 3.4 |
| `SMART_FINDING_CODES` | 8 个稳定 code：`reallocated-sectors`、`reported-uncorrectable`、`current-pending-sectors`、`offline-uncorrectable`、`udma-crc-errors`、`temperature-high`、`temperature-critical`、`attribute-failed` |
| `SMART_NOTE_CODES` | `invalid-input` / `smart-support-unknown` / `smart-support-unavailable` / `no-attributes` / `invalid-attribute-entry` / `skipped-attribute-lines` / `missing-attribute` / `unreadable-attribute` |
| `MEDIA_ERROR_ATTRIBUTE_IDS` | `[5, 187, 197, 198]`：`RAW_VALUE > 0` 即 warning |
| `CRC_ERROR_ATTRIBUTE_ID` | `199`：线材 / 接口 |
| `TEMPERATURE_ATTRIBUTE_ID` | `194` |
| `TEMPERATURE_WARNING_CELSIUS` | `55`：`raw > 55` warning |
| `TEMPERATURE_FAILED_CELSIUS` | `65`：`raw > 65` failed |
| `REQUIRED_ATTRIBUTE_IDS` | `[5, 187, 194, 197, 198, 199]`：缺任何一条都不能给 `ok` |
| `MIN_ATTRIBUTE_ID` / `MAX_ATTRIBUTE_ID` / `MAX_NORMALIZED_VALUE` | `1` / `255` / `255` |
| `MAX_ATTRIBUTE_NAME_LENGTH` / `MAX_FAILURE_TEXT_LENGTH` / `MAX_DETAIL_TEXT_LENGTH` | `64` / `40` / `160`（证据文本有界） |

## 3. 语义与安全边界（含「不猜」原则）

总原则一句话：**只报告输入里存在、且能被当前规则解释的东西；其余一律 `null` / `unknown` /
`note`。** 结论 `ok` 是「已经验证过」的意思，不是「没发现问题」的意思。

### 3.1 「不猜」清单（逐条）

1. **缺字段不回填**：`modelFamily` 与 `model` 是两个字段，谁缺谁 `null`；`Device Model`
   不会去补 `Model Family`。白名单之外的标签（`User Capacity`、`LU WWN Device Id`、
   `Form Factor`、`SATA Version is`）一律忽略，不往返回对象里塞。
2. **`SMART support is` 多行合并**：出现 `Unavailable` 或 `Disabled` → `unavailable`；
   出现 `Available` 或 `Enabled` → `available`；`Ambiguous ...` 或无法识别的措辞 → `null`。
   `Disabled` 映射为 `unavailable` 是刻意的——从「能不能读到属性」看两者等价，且能避免
   把「被关掉的 SMART」当成健康。原文不再保留，聚合到这一个状态里。
3. **`smartSupport` 不是 `available` 就不给 `ok`**：缺失、`null`、无法识别的字符串都记
   `smart-support-unknown` 并进入 `unknown`；明确 `unavailable` 记
   `smart-support-unavailable`。
4. **属性缺失不当通过**：`REQUIRED_ATTRIBUTE_IDS` 里任何一条缺失记
   `missing-attribute:<id>`（如 `missing-attribute:197`），并令覆盖度不完整；
   属性在、但 `RAW_VALUE` 取不到前导整数（`---`）记 `unreadable-attribute:<id>`。
   两者都会阻止 `ok`。
5. **解析失败的行不进结论**：`parseSmartAttributes` 把不可解析的数据样行跳过并计数，
   `summarizeSmartHealth` 读到 `skipped > 0` 会记 `skipped-attribute-lines:<n>` 并令
   覆盖度不完整；**被跳过的那一行可能恰好是要命的那条**，所以此时最多 `unknown`。
   跳过的行不会被猜列位置强行解析。
6. **不硬套 ATA 属性 ID**：NVMe 的 `-A` 文本没有属性表，解析结果为空数组 →
   `no-attributes` → `unknown`。本层不把 `Critical Warning`、`Media and Data Integrity
   Errors` 映射成 5/187/197/198。
7. **`RAW_VALUE` 只取行首整数**：`44 (0 18 0 0 0)` → `44`，`65 (45 65 0 0 0)` → `65`，
   `---` → 不可读。不在括号里找最大值，不做单位换算。已知局限见第 5 节。
8. **`when_failed` 不二次解释**：只要原文不是 `-`（含 `FAILING_NOW`、`In_the_past`），
   就按 smartctl 的判定记 `failed`；本层不判断「过去失败过算不算现在失败」。
9. **不看 `VALUE <= THRESH`**：ATA 归一化值在 SSD 上语义混乱，加这条规则会制造
   假阳性。判定只依赖 `when_failed` 与 `RAW_VALUE`，这是本层保守的一环。
10. **有界**：属性名、`when_failed` 原文、`detail` 都会截断到固定长度，设备输出再长也
    不会原样灌进结论；非对象 / 非数组输入不会抛异常。

### 3.2 判定规则表

| 条件 | 产出 | 结论权重 |
| --- | --- | --- |
| `info` 不是对象 | note `invalid-input:info` | `unknown` |
| `info.parsed === false` | note `invalid-input:info-unparsable` | `unknown` |
| `smartSupport === "unavailable"` | note `smart-support-unavailable` | `unknown` |
| `smartSupport` 为 `null` 或其它取值 | note `smart-support-unknown` | `unknown` |
| `attributes` 不是数组 | note `invalid-input:attributes` | `unknown` |
| `attributes` 为空数组 | note `no-attributes` | `unknown` |
| 数据样行解析失败（`skipped > 0`） | note `skipped-attribute-lines:<n>` | 覆盖度不完整 → `unknown` |
| 非属性对象 / 非法 id 的条目 | note `invalid-attribute-entry:<n>` | 覆盖度不完整 → `unknown` |
| 判定属性缺失 / 其 RAW 不可读 | note `missing-attribute:<id>` / `unreadable-attribute:<id>` | 覆盖度不完整 → `unknown` |
| 属性 5 / 187 / 197 / 198 的 `raw > 0` | finding `reallocated-sectors` / `reported-uncorrectable` / `current-pending-sectors` / `offline-uncorrectable`，severity `warning` | `warning` |
| 属性 199 的 `raw > 0` | finding `udma-crc-errors`，severity `warning`，detail 指明线材 / 接口 | `warning` |
| 属性 194 的 `raw > 55` 且 `<= 65` | finding `temperature-high`，severity `warning` | `warning` |
| 属性 194 的 `raw > 65` | finding `temperature-critical`，severity `failed`（不再重复报 warning） | `failed` |
| 任一属性 `whenFailed` 非 `null` | finding `attribute-failed`，severity `failed` | `failed` |

补充约定：

- 属性 194 同时越 55 与 65 时只出一条 `temperature-critical`，避免同一条属性刷两条告警；
- 同一属性同时满足 `when_failed` 与 `raw > 0` 时两条都会报（证据不同），排序时
  `failed` 在前；
- 重复的属性行不去重，每行都参与判定（如实反映输入）；
- `findings` 的排序是全序的：属性 id 升序 → `failed` 先于 `warning` → `code` 字典序，
  因此同样输入多次调用结果逐字节一致；
- `notes` 用 `Set` 去重，顺序固定为：输入问题 → SMART 支持状态 → 空表 → 非法条目 →
  跳过行数 → 缺失 / 不可读属性（按 id 升序）。

### 3.3 `ok` 的充要条件

`verdict === "ok"` 当且仅当**同时**满足：

1. `info.smartSupport === "available"`（明确可用，不是「缺失」也不是「没说不支持」）；
2. `REQUIRED_ATTRIBUTE_IDS` 六项全部出现，且每项 `RAW_VALUE` 的前导整数可读；
3. 没有解析失败的行、没有非法条目；
4. 没有产生任何 finding。

由此得到一个可断言的不变式：**`verdict === "ok"` ⟺ `notes` 为空**。反过来，`notes` 里
出现任何内容，结论就不可能是 `ok`。

### 3.4 结论优先级（为什么 `unknown` 只压 `ok`）

`VERDICT_PRECEDENCE = ["failed", "warning", "unknown", "ok"]`。

任务规则里「SMART 不可用 / 无属性 / 输入不可解析 → `unknown`」与「`raw > 0` → warning」
在一种输入下会冲突：`-i` 说 SMART 不可用，却又给了属性表且 `RAW_VALUE > 0`（采集层
拼错了盘，或设备自报矛盾）。此时：

- 若让 `unknown` 压过 `warning`，一条真实的「已重映射扇区 > 0」会被藏起来；
- 若让 `warning/failed` 压过 `unknown`，则永远不会在有问题时写 `ok`（本层最硬的约束
  是「绝不写 ok」，而不是「不可用时必须写 unknown」）。

因此选择后者：**真实告警优先，`unknown` 只压 `ok`**。反过来，只要存在任何 `unknown` 的
理由（SMART 不明、属性缺失、有行被跳过），结论就不可能升到 `ok`。

### 3.5 纯函数边界

- 模块内**没有任何模块引用**、没有文件 / 子进程 / 网络调用（测试会静态断言源码）；
- `summarizeSmartHealth` 不抛异常：`summarizeServices` 那种「非数组直接抛 `TypeError`」
  在这里是反模式——输入坏了本身就是一种要报告的结论，采集层不该为了兜底再包一层
  `try/catch`。唯一的例外是代码 bug，那属于测试范畴；
- 所有导出常量都是 `Object.freeze`，调用方改不动判定规则。

## 4. 测试结果

运行：

```
node --test tests/phase-192-smart-health.test.mjs
```

真实结果（Node v22.22.0，本机）：

```
# tests 23
# pass 23
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

23 个用例覆盖：

1. `parseSmartInfo`：ATA 全字段映射与字段顺序；NVMe 的 `Model Number` + 千分位
   `Power On Hours`；空 / 非字符串输入；`Unavailable` / `Disabled` / `Ambiguous`
   三种支持状态；「缺字段不回填」的整对象 `deepEqual`；文本值原样保留 + 非整数
   `powerOnHours` 置 `null`（4 个用例）。
2. `parseSmartAttributes`：整表逐字段 `deepEqual`（含 `010` → `10`）；
   `RAW_VALUE` 原文保留（`44 (0 18 0 0 0)`）；`FAILING_NOW` 与 `-` → `null`；
   三类坏行计数为 3 且表头 / banner / 分节线不计数；`skipped` 不可枚举
   （`deepEqual`、`Object.keys`、`JSON.stringify` 三路验证）；空 / 非文本输入
   （6 个用例）。
3. `summarizeSmartHealth`：干净报告的 `ok` 整对象 `deepEqual`；四个介质错误属性
   逐一 `warning`；199 的 `warning` 且 detail 含「线材 / 接口 / SATA」；温度边界
   55 / 56 / 65 / 66（`ok` / `warning` / `warning` / `failed`）；非判定属性
   184 的 `when_failed` 直接 `failed`；findings 排序 + 同 id 双 finding + 重复调用
   稳定；七种「不得 ok」的输入（不可用 / 支持状态缺失 / 无法识别 / `parsed: false`
   / `info: null` / 空属性表 / `attributes: null`）；缺属性 notes 与 `skipped` /
   非法条目 / RAW 不可读；10 种垃圾输入不抛异常且结果结构合法（13 个用例）。

未覆盖的真实场景（见遗留）：真机 `smartctl` 调用、NVMe 属性、温度非首位的固件、
多盘聚合。这些都需要采集层或后续解析器，不属于纯函数层。

说明：本阶段只跑了本测试文件。全量 `node --test` 目前会因 `docs-links.test.mjs`
（要求 `docs/README.md` 登记每一个文档）而失败——新增文档没有登记，而本阶段禁止修改
既有文件，见第 5 节。

## 5. 遗留

1. **采集器未接线**：本层只吃文本。真正调用 `smartctl -i` / `smartctl -A`（只读、
   `-d` 类型选择、超时、退出码、`/dev/sdX` 权限不足）的采集器由 Lead 后续注入，
   建议把「调用失败」映射成 `info: null` / `attributes: []`，本层会自然给出 `unknown`。
2. **`docs/README.md` 未登记本文档**：`tests/docs-links.test.mjs` 断言 `docs/README.md`
   列出了 `docs/` 下每一个文档，本阶段只能新建 3 个文件，所以无法补这一行；全量
   `node --test` 会因此失败。与 phase 190 是同一个限制，需要一次「文档索引」小阶段统一补。
3. **NVMe 的 SMART/Health 未解析**：NVMe 的 `-A` 输出是键值行（`Critical Warning`、
   `Media and Data Integrity Errors`、`Percentage Used`……），不是 ATA 属性表，目前
   一律 `no-attributes` → `unknown`。这是「不猜」的正确结果，但也是一个功能缺口，
   建议另开一个 `parseNvmeSmartHealth`（或在本模块加显式 NVMe 分支），映射到同一套
   finding code。
4. **温度取值只认行首整数**：绝大多数盘把当前温度放第一位（`44 (0 18 0 0 0)`、
   `65 (45 65 0 0 0)`），但若有固件把温度放在括号内、行首是 `0`，会被读成 0 而不告警。
   需要真机样本再决定是否增加「括号内字段位置」的显式规则，当前不猜。
5. **阈值未按盘型区分**：55 / 65 是通用常量；HDD、SATA SSD、NVMe 的正常温度区间不同，
   是否按 `rotationRate` / 接口类型覆盖阈值，留给 Lead 决定（当前实现是可配置的常量，
   改动集中在文件头）。
6. **多盘聚合未做**：`summarizeSmartHealth` 是单盘视图；多盘/多分区怎么汇总成整机
   `S06` 结论（最差盘优先？分别展示？）属于集成层决策。
7. **历史与趋势未做**：`powerOnHours` 只解析不判定；温度 / 重映射计数的趋势与告警
   抑制不在本阶段范围。

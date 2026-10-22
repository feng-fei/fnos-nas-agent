# Phase 188 — 容量趋势与容量预测（S14 / S17）

## 背景

能力矩阵里的 S14（历史趋势）与 S17（容量预测）一直标记为 Open：仓库已有 `overview.mjs` / `system-snapshot.mjs` 这类**当前状态**快照，但没有任何模块回答「照这个速度，磁盘什么时候满」。

本阶段只补「从已有采样推导结论」这一层：

- 不新增采集器、不读 `/proc`、不读 SMART、不发命令、不写盘；
- 输入是调用方已经攒下的样本 `{ at, diskUsedBytes, diskTotalBytes }`；
- 输出是纯数据：趋势、置信度、可选的写满天数，以及一条给界面用的一句话结论。

本次不接 HTTP 路由、不改 `server.mjs`、不动 UI：先把语义定下来并用测试钉死（详见「遗留」）。

## 导出 API 与字段

新增 `apps/fnos-nas-agent/app/capacity-forecast.mjs`（ESM，零依赖、零 I/O、没有 `import`）。

另导出以下常量：

| 常量 | 值 |
| --- | --- |
| `DEFAULT_SAMPLE_LIMIT` | `500` |
| `DEFAULT_HORIZON_DAYS` | `30` |
| `SAMPLE_DROP_REASONS` | `badTimestamp` / `badValue` / `usedExceedsTotal` / `duplicate` |
| `TREND_CONFIDENCES` | `low` / `medium` / `high` |
| `FORECAST_REASONS` | `insufficient-samples` / `no-growth` / `unknown-total` / `horizon-not-positive` |
| `TREND_VERDICT_STATUSES` | `ok` / `insufficient` / `unknown` |

### `normalizeSamples(input, { limit = 500 })`

返回 `{ samples, dropped, droppedReasons }`：

| 字段 | 含义 |
| --- | --- |
| `samples` | `{ at, diskUsedBytes, diskTotalBytes }[]`，按 `at` 升序、同一时间点去重、最多 `limit` 条 |
| `dropped` | 被判定为非法的样本数，恒等于 `droppedReasons` 四项之和 |
| `droppedReasons.badTimestamp` | `at` 不是字符串、解析失败，或样本不是对象 |
| `droppedReasons.badValue` | `diskUsedBytes` / `diskTotalBytes` 非数字、非有限、为负（数字字符串 `"1"` 也算非法） |
| `droppedReasons.usedExceedsTotal` | `diskUsedBytes > diskTotalBytes` |
| `droppedReasons.duplicate` | 解析后属于同一时间点、只保留输入顺序中最后一条 |

`at` 按**解析后的时间点**比较去重（`2026-01-01T00:00:00Z` 与 `2026-01-01T00:00:00.000Z` 视为同一个 `at`），保留的是输入顺序里靠后的那条，其原始 `at` 字符串一并保留。超过 `limit` 时丢弃最旧的、保留最新一段；**截断不属于非法样本，不计入 `dropped`**。`limit <= 0` 返回空窗口，非有限的 `limit` 回退到默认值。

### `summarizeTrend(samples)`

返回：

| 字段 | 含义 |
| --- | --- |
| `count` | 通过校验的有效采样总数 |
| `samplesUsed` | 真正参与斜率计算的采样数（总量变化后可能小于 `count`） |
| `windowDays` | 参与计算的采样覆盖的天数；不足两条时为 `0` |
| `diskGrowthBytesPerDay` | 相邻采样「增量 / 天数」的**中位数**；不足两条时为 `0` |
| `confidence` | `low` / `medium` / `high` |
| `notes` | 机器可读标记；目前只会出现 `total-changed-rebaselined` |

置信度按**真正参与计算的** `samplesUsed` 与 `windowDays` 判定，而不是输入条数：总量重定基后被丢掉的历史采样不能用来抬高置信度。

### `forecastCapacity(samples, { horizonDays = 30 })`

返回：

| 字段 | 含义 |
| --- | --- |
| `currentUsedBytes` / `currentTotalBytes` | 最后一条有效采样的已用 / 总量；无有效采样时为 `0` |
| `usedPercent` | 已用百分比，保留 1 位小数；总量为 0 时为 `0` |
| `projectedUsedBytes` | `当前已用 + 增长率 × horizonDays`，取整；负增长时封顶在当前已用 |
| `projectedUsedPercent` | 预测用量的百分比，保留 1 位小数；总量为 0 时为 `0` |
| `daysUntilFull` | 写满天数（向下取整）；不可算时为 `null` |
| `confidence` | 透传 `summarizeTrend().confidence` |
| `assumptions` | 中文假设说明，永远非空 |
| `reason` | `daysUntilFull === null` 时的原因；可算时为 `null` |

`horizonDays` 必须是**有限的数字且大于 0**，否则抛 `TypeError`（`0`、负数、`NaN`、`±Infinity`、字符串 `"30"`、`null` 都拒绝）。

`daysUntilFull` 只在三个条件同时成立时给出：**增长率为正 + `confidence !== "low"` + 总量大于 0**。否则为 `null`，`reason` 按以下优先级给出：

1. `insufficient-samples` — 置信度为 `low`（有效采样 < 3 条或跨度 < 1 天）；
2. `unknown-total` — 总量为 0 或缺失；
3. `no-growth` — 增长率小于等于 0。

`horizon-not-positive` 目前是**不可达**的防御性取值：非法 `horizonDays` 在进入计算前就抛 `TypeError` 了，保留它只是给调用方的错误分支一个稳定字符串。

### `buildTrendVerdict(samples, { horizonDays } = {})`

返回 `{ status, headline, items, notes }`：

- `status`：
  - `insufficient` — 置信度为 `low`；`headline` 固定包含「样本不足，暂不预测」，且不含任何预测数字；
  - `unknown` — 样本够但总量未知；只报当前已用，不猜使用率与剩余空间；
  - `ok` — 给增长量、使用率与（可算时）写满天数；
- `items`：`{ label, value, unit, note }[]`，`value` 是数字或 `null`（不可得时），`note` 说明口径；
- `headline`：中文一句话；
- `notes`：中文说明数组，包含有效采样数、参与计算的采样数、跨度与置信度；总量重定基与样本不足会各加一条。

`horizonDays` 的校验复用 `forecastCapacity`：非法值同样在 `buildTrendVerdict` 里抛 `TypeError`，不会产出半成品结论。

## 算法与「不猜」原则

### 1. 增长率用中位数，不用最小二乘

对同一总量段内相邻的两条采样：

```text
增量_i = (used_i - used_{i-1}) / (at_i - at_{i-1} 的天数)
增长率 = median(增量_1 … 增量_n)
```

偶数条增量时取中间两条的算术平均。选它的理由很直接：一次 50 GiB 的大拷贝或一次清理，会把最小二乘斜率整体带偏，而中位数只影响一个增量。测试里 `[10, 11, 12, 100, 13]` GiB 的增量是 `1、1、88、-87` GiB/天，中位数仍是 `1 GiB/天`。

### 2. 置信度只看真正用到的证据

| 条件 | 置信度 |
| --- | --- |
| `samplesUsed < 3` 或 `windowDays < 1` | `low` |
| `samplesUsed >= 3` 且 `1 <= windowDays < 3` | `medium` |
| `samplesUsed >= 3` 且 `windowDays >= 3` | `high` |

`low` 是硬门槛：不给写满天数。

### 3. 总量变化时重定基

如果 `diskTotalBytes` 中途变化（换盘、扩容、重建存储池），只在**以最后一条采样结尾、总量值相同的最长连续段**上计算增长与跨度，并在 `notes` 里记 `total-changed-rebaselined`。这样旧总量下的绝对增量不会被当成新总量下的增长。置信度也按这一段判定——这正是 `count` 与 `samplesUsed` 分开的原因。

### 4. 写满天数与原因

```text
daysUntilFull = floor((total - used) / growth)   // 仅当 growth > 0 且 confidence !== low 且 total > 0
```

取整用 `floor`（宁可说早一天，不把风险说小），实现里加了 `1e-9` 的容差，避免 `3 / 0.1 = 29.999999999999996` 被算成 29 天。

### 5. 负增长不做乐观外推

增长率为负时 `projectedUsedBytes` 封顶在当前使用量（不会低于当前值），并在 `assumptions` 里用中文写明「负增长（可能发生过清理或迁移）」。同时 `reason = "no-growth"`、`daysUntilFull = null`：趋势会回落，但容量结论不假设「未来一定还会清理」。

### 6. 「不猜」清单

| 情况 | 行为 |
| --- | --- |
| 有效采样不足 | `confidence: "low"`，`daysUntilFull: null`，`reason: "insufficient-samples"`；结论态 headline 明说「样本不足，暂不预测」 |
| 总量为 0 / 缺失 | `usedPercent` 与预测百分比都给 `0`，`reason: "unknown-total"`，不拿已用量去猜总量 |
| 增长率为 0 或负 | 不给天数；`ok` 态仍可给当前使用率与「不会写满」的结论 |
| 总量中途变化 | 只算最后一段，并显式记录，不混算 |
| 没有样本 | `currentUsedBytes` / `currentTotalBytes` 为 0，结论 `insufficient`，不编数字 |
| 非法 `horizonDays` | 直接 `TypeError`，不降级、不默认 |

所有展示值只有两种来源：输入里真实存在的采样，或由采样显式算出的量。没有采集、没有探测、没有默认假设。

## 测试

命令（仓库根执行）：

```powershell
node --check apps/fnos-nas-agent/app/capacity-forecast.mjs
node --check tests/phase-188-capacity-forecast.test.mjs
node --test tests/phase-188-capacity-forecast.test.mjs
```

真实结果：`tests 16 / pass 16 / fail 0`（Node v22.22.0，本机）。

`tests/phase-188-capacity-forecast.test.mjs` 的 16 个用例：

| # | 场景 | 钉住的语义 |
| --- | --- | --- |
| 1 | 非法时间戳 | 非对象、不可解析 `at` 计入 `badTimestamp`；非数组输入退化为空 |
| 2 | 非法数值 | 负数 / `NaN` / `Infinity` / 数字字符串计入 `badValue`；`used > total` 单独计数 |
| 3 | 排序与去重 | 升序排列；同一时间点（含不同 ISO 写法）只留最后一条 |
| 4 | `limit` 截断 | 保留最新 3 条；截断不计入 `dropped` |
| 5 | 稳态 | 9 天 10 条采样，增长 `0`、置信度 `high`、`no-growth`、预测值等于当前值 |
| 6 | 线性增长 | 10 天增长 3 GiB/天，(100−50)/3 向下取整得 `16` 天，预测 140% |
| 7 | 单点离群 | 增量 `1、1、88、-87` 的中位数仍为 1 GiB/天，天数 `987` |
| 8 | 总量中途变化 | `count=6` 但 `samplesUsed=3`、`windowDays=2`、`medium`，notes 含 `total-changed-rebaselined`，天数 `48` |
| 9 | 样本不足 | 2 条与 0 条都给 `low` / `insufficient-samples` / `null` 天数 |
| 10 | `horizonDays` 非法 | `0`、`-1`、`NaN`、`Infinity`、`"30"`、`null` 全部 `TypeError`，`buildTrendVerdict` 同样 |
| 11 | 总量为 0 | `unknown-total`，百分比 `0`，不编天数 |
| 12 | 负增长 | `no-growth`，预测值封顶在当前值 48 GiB，assumption 含「负增长」 |
| 13 | 结论 ok | headline 含「16 天」「写满」；items 三项，写满 `16` 天、使用率 `50` |
| 14 | 结论 insufficient | headline 含「样本不足，暂不预测」且不含数字，items 里没有「预计写满」 |
| 15 | 结论 unknown | 只报当前已用，磁盘总量 `value: null`，headline 不含数字 |
| 16 | 模块纯净度 | 源码没有 `import`，不出现 `node:fs` / `node:child_process` / `node:http` / `fetch` / `process.env` |

## 遗留

- **未接 HTTP 与 UI**：本阶段只交付纯函数层，`server.mjs`、`ui/` 均未改动；要在概览页展示需要下一阶段加路由与只读卡片。
- **`docs/README.md` 尚未收录本文档**：受「只允许新建三个文件」约束，本次没有改索引。`tests/docs-links.test.mjs` 要求 `docs/` 下每个文档都出现在 `docs/README.md` 里，因此**在补上 Phase 188 索引条目之前，全量 `node --test` 会在这条用例上失败**，而本阶段指定的单文件测试不受影响。
- **没有采样与持久化**：样本由调用方提供；定时评估需要复用现有的快照调度器，本模块刻意不碰存储。
- **`dropped` 不包含窗口截断**：调用方若想知道被 `limit` 丢掉了多少条，需要自己比较输入长度与 `samples.length`；这是为了让 `dropped` 与 `droppedReasons` 严格对账。
- **中位数只抗离群**：它不识别阶跃（例如一次性迁移 200 GiB），也不会把阶跃判成异常；总量变化已单独处理，使用量阶跃仍会被弱化成一天的大增量。
- **单卷模型**：契约是单个 `used/total` 对，不处理多盘 / 多卷；多卷需要调用方自己聚合或按卷分别调用。
- **`horizon-not-positive` 不可达**：保留为稳定字符串，若未来改为「非正 horizon 返回结构化错误」再启用。

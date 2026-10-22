# Phase 204 — Docker 实时资源采样的解析与判定层

## 1. 背景

APP02（容器资源分析）在能力对照表里的状态是 **Partly**：仓库里已有的
`deployment-precheck.mjs`、`docker-advisor.mjs` 等只做静态建议与部署前检查，
缺的是"把 Docker 当前的运行数据采回来、算清楚、给出可引用的证据"这一环。

Phase 204 只补**分析层**：

- 把 `docker stats` 的一行原始输出解析成结构化数值；
- 对一组样本做窗口汇总（最忙的容器、总占用、空转数）；
- 对五类资源异常做判定，并按严重级别排序；
- 生成 `{ summary, findings, evidence }`，供后续报告 / 路由直接挂载。

真正执行 `docker` 的**采集器**与对外暴露的 **`/api/docker/stats` 路由**
不在本阶段（见第 7 节遗留），这样分析逻辑可以先被纯数据单测锁住，接线时
只需把 stdout 逐行喂给 `parseStatsLine`。

本阶段只新增三个文件，没有修改任何已有文件。

## 2. 输入格式假设

1. **来源**：Docker 19.03+ 的 `docker stats --no-stream --format json`
   （等价写法 `--format '{{json .}}'`）。每一行是一个 JSON 对象，键为
   `Container`、`Name`、`CPUPerc`、`MemUsage`、`MemPerc`、`NetIO`、`BlockIO`、
   `PIDs`，与常量 `STATS_COLUMNS` 一致。
2. **字段形态**：
   - `CPUPerc` / `MemPerc` 是带 `%` 的百分比字符串，例如 `1.50%`、`0.00%`；
   - `MemUsage` 是 `已用 / 上限`，例如 `12.34MiB / 1GiB`；
   - `NetIO` 是 `入 / 出`，`BlockIO` 是 `读 / 写`；
   - `PIDs` 是非负整数，取不到时 Docker 会给 `--` 或 `N/A`；
   - 取不到的值一律是 `N/A`（区分大小写不敏感）。
3. **表格行也接受**：同一函数兼容 `docker stats` 的经典表格行（列间为两个
   及以上空格或 tab），用于回放与手工测试。表格行必须恰好切出与 `columns`
   相同数量的列，否则按 `invalid-json` 拒绝，不做位置猜测。
4. **不假设采样频率**：本层是纯函数。样本的 `sampledAt` 只在调用方显式传入
   `now` 时才参与"是否过期"的判断；函数本身不读时钟。
5. **不假设容器唯一**：`samples` 是时间序列，同一个容器可以出现多次，汇总按
   样本计，判定按容器名分组、以最新样本为准。

## 3. 导出 API

### 3.1 常量

| 导出 | 值 | 说明 |
| --- | --- | --- |
| `STATS_COLUMNS` | `["Container","Name","CPUPerc","MemUsage","MemPerc","NetIO","BlockIO","PIDs"]`（冻结） | JSON 键与表格列的顺序 |
| `MAX_SAMPLES` | `200` | 窗口最多保留的最新样本数 |
| `MAX_NAME_LENGTH` | `120` | detail 中容器名的最大长度 |
| `STATS_PARSE_REASONS` | `empty-line` / `invalid-json` / `missing-name` / `invalid-cpu` / `invalid-memory` | 解析失败原因的封闭集合 |
| `STATS_ANOMALY_KINDS` | `cpu-saturation` / `memory-pressure` / `memory-near-limit` / `io-stall` / `restart-loop` | 异常种类的封闭集合 |
| `DEFAULT_STATS_THRESHOLDS` | `{cpuPercent:90, memoryPercent:90, memoryNearLimitPercent:98, restartCount:3, maxSampleAgeMs:300000}`（冻结） | 默认阈值 |

### 3.2 `parseStatsLine(line, { columns = STATS_COLUMNS } = {})`

解析一行输出。

成功：

```js
{
  ok: true,
  container: {
    id: string,              // Container；缺失时退回 ID / ContainerID，再缺失为 ""
    name: string,            // Name，去空白；前导 "/" 会被去掉
    cpuPercent: number|null, // "1.5%" -> 1.5，"N/A" -> null
    memUsedBytes: number|null,
    memLimitBytes: number|null,
    memPercent: number|null,
    netRxBytes: number|null,
    netTxBytes: number|null,
    blockReadBytes: number|null,
    blockWriteBytes: number|null,
    pids: number|null
  }
}
```

失败：`{ ok: false, reason }`，`reason` 取值与触发条件（按检查顺序）：

| reason | 触发条件 |
| --- | --- |
| `empty-line` | 输入不是字符串，或去空白后为空 |
| `invalid-json` | 不是 JSON 对象，且不是能按 `columns` 精确切分的表格行 |
| `missing-name` | `Name` 缺失或去空白后为空（含只由 `/` 组成） |
| `invalid-cpu` | `CPUPerc` 不是 `数字%`，也不是 `N/A`（无单位数字会被拒绝） |
| `invalid-memory` | `MemUsage` 缺失、不符合 `已用 / 上限`、或任一部分不是合法字节数；或 `MemPerc` 存在但既不是百分比也不是 `N/A` |

补充约定：

- `MemPerc` **缺省**（键不存在）视为未知 `null`，不算失败；这样 `columns`
  裁剪过的表格行也能解析。
- `NetIO` / `BlockIO` 缺失或畸形 → 两个 `null`，**不**让整行失败：封闭原因
  清单里没有 I/O 原因，这里宁可把 I/O 标成未知也不编造错误。
- `PIDs` 为 `--`、空串或非整数 → `null`。

### 3.3 字节单位

| 单位 | 进制 | 字节数 | 示例 |
| --- | --- | --- | --- |
| `B` | 1 | 1 | `0B` → 0 |
| `kB` | 1000^1 | 1 000 | `1.2kB` → 1200 |
| `MB` | 1000^2 | 1 000 000 | `1MB` → 1000000 |
| `GB` | 1000^3 | 1 000 000 000 | `1.25GB` → 1250000000 |
| `KiB` | 1024^1 | 1 024 | `1.5KiB` → 1536 |
| `MiB` | 1024^2 | 1 048 576 | `12.34MiB` → 12939428 |
| `GiB` | 1024^3 | 1 073 741 824 | `1GiB` → 1073741824 |
| `TiB` | 1024^4 | 1 099 511 627 776 | `1TiB` → 1099511627776 |

**单位是必需的**：`12`、`12.34` 这类裸数字一律不接受（`invalid-memory`），
不会被当作字节。`TB`、`kb`、`M` 等未列出的单位同样不接受。

### 3.4 `summarizeStats(samples, { top = 5 } = {})`

```js
{
  count,                 // 参与统计的样本条数（不是容器数）
  totalCpuPercent,       // 已知 CPU% 之和，四舍五入到 2 位
  totalMemUsedBytes,     // 已知 memUsedBytes 之和
  topCpu: [{ name, cpuPercent }],
  topMemory: [{ name, memUsedBytes }],
  unknownCount,          // cpuPercent 未知的样本条数
  idleCount              // cpuPercent 已知且 <= 0.05 的样本条数
}
```

- 只保留最新的 `MAX_SAMPLES`（200）条，超出部分丢弃，不做平均；
- 样本可以是容器对象本身，也可以是 `parseStatsLine(...)` 的返回值（自动取
  `.container`）；名字为空的条目直接丢弃；
- 负数、`NaN`、`Infinity` 视为未知；
- `top` 默认 5，可下调/上调，上限 200；同值按名称升序，保证输出稳定；
- `topCpu` / `topMemory` 只列已知值，未知值不参与排序；
- 全部样本都未知时 `totalCpuPercent` 为 0，必须结合 `unknownCount` 判断，
  不能把 0 读成"空闲"。

### 3.5 `detectStatsAnomalies(samples, { now, restarts = {}, thresholds } = {})`

返回 `[{ kind, severity, container, detail }]`，`severity ∈ info|warning|critical`。

分组与取值：

- 按 `name` 分组；`restarts` 以容器名优先、容器 id 兜底；
- 当前 CPU / 内存压力只看每个容器的**最新样本**，旧样本不参与；
- 最新样本中某字段为 `null` 表示未知，**不继承**更早的读数；
- `restarts` 里有、样本里没有的容器也会被检查（可能没产出 stats 行）；
- 输出排序：`critical` → `warning` → `info`，同级别按 `kind`，再按容器名。

五类判定的默认阈值：

| kind | 级别 | 默认触发条件 | 说明 |
| --- | --- | --- | --- |
| `cpu-saturation` | warning | 最新 `cpuPercent >= 90` | 相对单核百分比，可 >100 |
| `memory-pressure` | warning | 最新 `memPercent >= 90` 且 `< 98` | 与 near-limit 互斥，只报一条 |
| `memory-near-limit` | critical | 最新 `memPercent >= 98` | 优先于 pressure |
| `io-stall` | warning | 最新两个样本 `read+write` 增量 `<= 0` 且 `pids` 相同 | 两端 read/write/pids 都必须已知；计数器重置（增量负数）也算停滞 |
| `restart-loop` | critical | `restarts[name] >= 3` | 只看调用方给的计数，缺失不当 0 |

阈值覆盖：

- `thresholds` 的键与默认阈值同名；只接受有限非负数，其他值（字符串、负数、
  `NaN`）忽略并沿用默认值；
- 过期判定：只有 `now` 与样本的 `sampledAt` **都能解析**、且
  `now - sampledAt > maxSampleAgeMs`（默认 5 分钟）时，最新样本才被视为过期，
  不参与 CPU / 内存判定；`io-stall` 与 `restart-loop` 不受影响；
- 没有 `now`、没有 `sampledAt`、或时间戳非法 → 无法证明过期，按未过期处理。

### 3.6 `buildStatsEvidence(samples, { limit = 10 } = {})`

```js
{
  summary,   // summarizeStats(samples) 的完整结果
  findings,  // detectStatsAnomalies(samples) 的前 limit 条
  evidence: [{ source: "docker-stats", detail, confidence }]
}
```

- `detail` 形如 `容器名: 判定详情`，容器名截断到 `MAX_NAME_LENGTH`（120，
  截断后以 `...` 结尾），整条 detail 再截断到 240；
- `confidence` 由级别映射：`critical → high`、`warning → medium`、
  `info → low`；
- `limit` 默认 10，取值范围 0..200，非法值回退默认 10；
- 样本为空时，`evidence` 给出一条低置信条目：

  ```
  no docker-stats sample was supplied; resource usage is unknown
  ```

  避免"空数组 = 一切健康"的误读；
- 有样本但没有异常时，`findings` 与 `evidence` 都是空数组（这是真正测量过的
  平静，与上一条的"未测量"区分开）。

## 4. 安全边界

1. **纯函数，无副作用**：`docker-stats.mjs` 没有 `import`、没有 `require`、
   没有文件/网络/子进程/Docker socket 访问，也不读时钟（`now` 由调用方传入）。
   测试用源码断言锁住这条边界。
2. **不猜数值**：`N/A` → `null`；解析不了 → `null` 或结构化错误；无单位数字
   拒绝；`memPercent` 绝不由 `memUsedBytes / memLimitBytes` 反推。
3. **未知 ≠ 健康**：字段缺失保持未知；未知不产生异常，也不清除已测得的结论；
   空输入用显式 evidence 声明"未采样"。
4. **有界输出**：窗口 200 条、名字 120 字符、detail 240 字符、findings/evidence
   受 `limit` 限制（≤200），避免异常名称或极端数字撑大输出。
5. **只读**：不产生任何执行动作或 Docker 调用；不修改传入的数组与对象
   （测试断言输入在调用前后深相等）。
6. **不做推断**：缺 restart 计数不当 0，缺 block-IO / PIDs 不产生 io-stall，
   最新样本缺 CPU/内存时不拿旧样本顶替。

## 5. 测试结果

命令与结果（本机实测）：

```text
$ node --check apps/fnos-nas-agent/app/docker-stats.mjs
（通过，无输出）

$ node --test tests/phase-204-docker-stats.test.mjs
...
# tests 24
# suites 0
# pass 24
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 约 190 ms
```

24 个用例分组：

| 分组 | 用例数 | 覆盖点 |
| --- | --- | --- |
| 常量与封闭集合 | 1 | 列顺序、冻结、`MAX_SAMPLES` / `MAX_NAME_LENGTH`、原因与异常枚举、默认阈值 |
| 解析 | 9 | `--format json`、`{{json .}}`（多 `ID`/前导 `/`）、表格行与自定义 `columns`、CPU 百分比、全部字节单位、`N/A → null`、非法 CPU、非法内存、结构错误原因 |
| 汇总 | 4 | topCpu/topMemory 排序与截断、idle/unknown 计数、`MAX_SAMPLES` 截断、空输入/包装对象/非变异 |
| 判定 | 6 | cpu、memory（pressure 与 near-limit 互斥）、io-stall（含停滞/计数器重置/增长/pid 变化）、restart-loop（含阈值、仅出现在 restarts 的容器）、未知字段不推断、排序与过期样本 |
| 证据 | 3 | `limit` 截断、名字截断与 evidence 结构、空样本声明 |
| 纯净性 | 1 | 源码无 `import`/`require`/I/O/子进程/时钟 |

## 6. 与现有模块的关系

- **不替代** `docker-advisor.mjs`：后者给静态优化建议，本层只回答"现在怎么样"；
- **不依赖** `deployment-precheck.mjs`：两者都是纯分析模块，互不引用；
- 输入即 `docker stats` 的输出，输出即后续报告可以直接引用的
  `{summary, findings, evidence}`，中间不需要再做格式转换。

## 7. 遗留

1. **采集器未接**：需要在 `app/server.mjs` 增加一次性的
   `docker stats --no-stream --format json` 采集（建议 `execFile` 带超时，
   避免 `docker` 卡住拖垮主进程），把 stdout 按行交给 `parseStatsLine`，
   再按时间窗口保留样本。Docker 不可用/无权限时必须显式报错，不能把失败
   当成"没有容器"。
2. **路由未接**：建议 `GET /api/docker/stats?limit=`，放在 `app/server.mjs`
   现有 `/api/docker/advice` 处理器旁（当前约 L2388），审计名 `docker.stats`
   加在 `docker.advice` 的映射旁（当前约 L912）。注意：并行阶段正在改动
   `server.mjs`，行号以集成时为准。
3. **文档索引未更新**：本阶段约束是不修改已有文件，因此 `docs/README.md`
   尚未收录本篇。全量测试时 `tests/docs-links.test.mjs` 会把
   `phase-204-docker-stats.md` 列入 "every document must be listed in
   docs/README.md" 清单，需与并行阶段一起在集成时补索引。
4. **未接上层**：还没有前端/报告/告警使用本层输出，也没有与
   `deployment-precheck.mjs` 的静态结论合并。
5. **CPU% 未归一化**：`docker stats` 的 CPU% 是相对单核（可 >100%），本层按
   原值比较阈值；若要按整机核数计算"总饱和度"，应在采集器换算后再传入。
6. **采样频率与保留策略由采集器决定**：本层只保证超过 `MAX_SAMPLES` 时取最新
   的 200 条，不负责定时、去重或持久化。

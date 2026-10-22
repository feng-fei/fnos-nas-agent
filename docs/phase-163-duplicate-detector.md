# Phase 163 — 重复文件检测与归档候选

用户功能清单模块 04「智能文件管理与搜索」里有四个需求天然属于同一类问题：
**先看清，再动手**。F07 重复文件检测要结合大小、哈希与内容校验找出冗余副本；
F08 临时文件识别、F09 自动归档、F11 整理预览则是同一批候选文件的不同归宿——
识别出来、规划一份去处、摆在用户面前等他确认。

本阶段把这四件事实现为一个**纯逻辑 + 注入式文件系统访问**的模块
`apps/fnos-nas-agent/app/duplicate-detector.mjs`：文件遍历与哈希计算由调用方以
函数注入（`listEntries` / `readHash`），模块自身**不 import node:fs**，
既不读文件也不写文件。F09 自动归档在本阶段只产出**只读计划**（`planArchive`），
绝不自行移动或删除任何文件。

## 1. 背景：模块 04 的功能编号对照

| 编号 | 需求 | 本阶段对应实现 | 状态 |
| --- | --- | --- | --- |
| F07 | 重复文件检测（大小 + 哈希 + 内容校验） | `groupBySize()` + `detectDuplicates()` | 已覆盖（分析层） |
| F08 | 临时文件识别 | `planArchive()` 的 `ext` / `namePattern` / `olderThanDays` 规则 | 已覆盖（只出计划） |
| F09 | 自动归档 | `planArchive()` 生成 `moves` 计划 | 已覆盖（只读计划，不执行） |
| F11 | 整理预览 | `planArchive()` 的 `moves` / `skipped` / `freedBytes` + `dryRun` | 已覆盖（预览数据） |
| F23 | 权限感知搜索 | 本阶段不涉及（需要搜索服务与鉴权上下文） | 未覆盖，见第 8 节 |
| F24 | 索引管理 | `describeIndexState()` 给出 `ok` / `stale` / `unknown` 状态 | 已覆盖（状态描述） |

F07 的三段式判定被拆成两阶段：先按**大小**分组（省 IO），只对同大小的组计算
**哈希**，哈希一致才算重复。内容校验由注入的 `readHash` 承担，本阶段不自带
任何摘要算法实现。

## 2. 变更边界

本阶段**只新增**三个文件：

| 文件 | 作用 |
| --- | --- |
| `apps/fnos-nas-agent/app/duplicate-detector.mjs` | ES module，导出 4 个纯函数；无 fs、无网络、无副作用 |
| `tests/phase-163-duplicate-detector.test.mjs` | `node --test` 用例，31 个 |
| `docs/phase-163-duplicate-detector.md` | 本文档 |

明确**没有**发生的事：

- 没有修改 `server.mjs`、任何既有后端模块、任何 UI 文件；
- 没有新增、修改或删除任何 HTTP 路由；
- 没有把模块挂到 `app/ui/` 或任何页面；
- 没有修改 `README.md`、`docs/README.md`、`scripts/check-release-gates.mjs`；
- 没有执行 `git commit` 或 `git push`；
- 没有读写、移动、删除任何文件。

## 3. 导出 API 约定

```js
import {
  groupBySize,
  detectDuplicates,
  planArchive,
  describeIndexState
} from "./duplicate-detector.mjs";
```

| 导出 | 签名 | 返回 | 说明 |
| --- | --- | --- | --- |
| `groupBySize` | `(entries: Array<{path, size, mtimeMs?}>) => Array<{size, paths: string[]}>` | 同大小分组 | 只保留**出现次数 ≥ 2** 的分组，按 `size` 升序；组内 `paths` 去重并按字典序排列 |
| `detectDuplicates` | `(options) => Promise<{scanned, candidates, groups, truncated, skipped}>` | 检测结果 | `options` = `{listEntries, readHash, limit = 2000, maxHashBytes = 64 MiB, dir = "."}` |
| `planArchive` | `(entries, {rules = [], dryRun = true, now = Date.now()}) => {moves, skipped, freedBytes, dryRun}` | **只读计划** | 永不移动文件；`moves` 形如 `{from, to, reason}` |
| `describeIndexState` | `({indexedPaths = 0, excludedPaths = [], lastUpdatedAt = null, dirty = false}) => {status, indexedPaths, excludedCount, lastUpdatedAt, dirty}` | 索引状态 | `status` ∈ `ok` / `stale` / `unknown` |

### 3.1 `detectDuplicates` 的字段

| 字段 | 含义 |
| --- | --- |
| `scanned` | 实际参与分析的条目数（`limit` 之内） |
| `candidates` | 进入哈希阶段的文件数（只统计「同大小且至少两份」的组） |
| `groups` | 重复组，元素为 `{size, hash, paths, wastedBytes}`；`wastedBytes = size × (paths.length - 1)` |
| `truncated` | 因超过 `limit` 而提前停止扫描时为 `true` |
| `skipped` | 未能完成判定的文件，形如 `{path, reason, detail?}` |

`skipped[].reason` 的取值：

| reason | 含义 |
| --- | --- |
| `invalid-entry` | 条目缺 `path` 或 `size` 非法 |
| `invalid-list` | `listEntries` 返回的不是数组 |
| `list-failed` | `listEntries` 抛错（`detail` 里有摘要） |
| `too-large` | 文件大于 `maxHashBytes`，按策略不计算哈希 |
| `hash-failed` | `readHash` 抛错（`detail` 里有摘要） |
| `invalid-hash` | `readHash` 返回的不是非空字符串 |

**哈希读取失败的文件进入 `skipped`，绝不会被当作重复文件。**

### 3.2 `planArchive` 的规则

规则形如 `{ id, match, target }`，`match` 可组合 `ext` / `namePattern` /
`olderThanDays` / `minSizeBytes`，**同一规则内全部条件都满足才算命中**：

```js
const plan = planArchive(entries, {
  rules: [
    { id: "temp", match: { ext: [".tmp", ".log"], olderThanDays: 30 }, target: "/archive/temp" },
    { id: "big-media", match: { namePattern: "*-1080p.*", minSizeBytes: 1 << 30 }, target: "/archive/media" }
  ],
  dryRun: true
});
```

- `ext` 大小写不敏感，`"tmp"` 与 `".tmp"` 等价；无扩展名的文件用 `""` 表示。
- `namePattern` 含 `*` / `?` 时按 glob 匹配文件名，否则按不区分大小写的子串匹配。
- `olderThanDays` 以 `mtimeMs` 与 `now` 的差值判定（默认 `now = Date.now()`，可注入以便测试）。
- `minSizeBytes` 是下界（`size >= minSizeBytes`）。
- 没有给出任何匹配条件的规则**不命中任何文件**（避免误归档）。
- 已位于目标目录的文件记入 `skipped`，理由 `already-in-target`，不会自我搬移。
- `moves[].reason` 形如 `rule:<id>`；`freedBytes` 是计划搬离源目录的总字节数。

## 4. 安全设计

1. **只读计划。** `planArchive()` 只计算「谁搬到哪、为什么、腾出多少字节」，
   返回值里没有任何写操作入口；模块内不存在移动、复制、删除的代码路径。
2. **无文件写入能力。** 模块**不 import `node:fs`**，测试
   「the module never imports a file system write capability」直接扫描源码，
   断言不存在 `unlink(` / `rename(` / `writeFile(` / `rm(` / `copyFile(` 等调用。
3. **注入式文件系统访问。** 遍历与哈希由调用方注入，模块无法自行扩大权限边界。
4. **失败不伪装成重复。** `readHash` 抛错、`listEntries` 抛错、哈希格式异常，
   一律进 `skipped` 并写明理由，不会让「读不到」的文件混进重复组。
5. **两阶段扫描省 IO。** 只有同大小的组才计算哈希，显著降低大目录的读取量。
6. **上限保护。** `limit`（默认 2000）限制参与分析的条目数，超出即 `truncated = true`
   并停止扫描；`maxHashBytes`（默认 64 MiB）之上的文件直接 `too-large` 跳过。
7. **不落文件内容。** 结果里只有路径、大小、哈希与状态，没有文件正文、片段或预览。
8. **错误摘要受限。** `detail` 只取错误 `message` 并压成单行、截断到 200 字符，
   不携带堆栈。

## 5. 未改变的红线

- 未修改 `fnos-nas-agent` 的任何既有文件（含 `server.mjs` 与全部 UI 文件）；
- 未新增 HTTP 路由，未放宽任何鉴权、限流与路径白名单规则；
- 未引入任何第三方依赖（仅 ESM 与调用方注入的函数）；
- **权限边界不变**：本阶段不触碰既有工具的 `read-only` / `write` / `destructive`
  风险分级，`destructive` 工具依旧需要显式审批与 capability 才能执行；
- 未执行 `git commit` / `git push`；
- 未对任何真实文件做读、写、移动或删除。

## 6. 测试清单

```bash
node --test tests/phase-163-duplicate-detector.test.mjs
```

共 31 个用例，全部通过（`# pass 31 / # fail 0`）：

| # | 用例 | 覆盖点 |
| --- | --- | --- |
| 1 | groupBySize keeps only groups that hold two or more files | 只保留 ≥2 的分组 |
| 2 | groupBySize sorts the kept groups by size ascending | 按 size 升序 |
| 3 | groupBySize ignores malformed entries | 非法条目被忽略 |
| 4 | groupBySize returns an empty array for a non array input | 非数组输入 |
| 5 | detectDuplicates reports files with different sizes as separate | **不同 size 不算重复** |
| 6 | detectDuplicates groups files that share size and hash | 同 size 同 hash 成组 |
| 7 | detectDuplicates reports the wasted bytes of a group | `wastedBytes` 计算 |
| 8 | detectDuplicates only hashes files that share a size | 只对同 size 组算哈希 |
| 9 | detectDuplicates sends a failing hash to skipped and never calls it a duplicate | **readHash 失败进 skipped** |
| 10 | detectDuplicates never groups a file whose hash could not be read | 失败文件不入组 |
| 11 | detectDuplicates skips files larger than maxHashBytes | `too-large` |
| 12 | detectDuplicates stops at the limit and reports truncated | **超过 limit 触发 truncated** |
| 13 | detectDuplicates is not truncated when the listing fits the limit | 未超限不置位 |
| 14 | detectDuplicates reports malformed listing entries as skipped | `invalid-entry` |
| 15 | detectDuplicates survives a failing listEntries call | `list-failed` 不抛 |
| 16 | detectDuplicates rejects a missing listEntries or readHash | 参数校验 |
| 17 | detectDuplicates never returns file contents | 不返回文件内容 |
| 18 | planArchive defaults to a dry run and returns a plan only | **默认 dryRun 且只出计划** |
| 19 | planArchive reports files that no rule matches | `no-matching-rule` |
| 20 | planArchive matches by name pattern | `namePattern` |
| 21 | planArchive matches by olderThanDays | `olderThanDays` |
| 22 | planArchive matches by minSizeBytes | `minSizeBytes` |
| 23 | planArchive refuses to move a file that already lives in the target directory | `already-in-target` |
| 24 | planArchive keeps a plan even when dryRun is disabled and performs no file operation | 关闭 dryRun 仍无副作用 |
| 25 | planArchive rejects a rule without a target | 规则必须有 target |
| 26 | planArchive rejects invalid arguments | 参数校验 |
| 27 | describeIndexState reports an ok index | F24 `ok` 态 |
| 28 | describeIndexState reports a stale index when it is dirty | F24 `stale` 态 |
| 29 | describeIndexState reports an unknown index when it was never updated | F24 `unknown` 态 |
| 30 | describeIndexState normalises a numeric timestamp | 时间戳归一 |
| 31 | the module never imports a file system write capability | **无写文件能力** |

## 7. 集成说明

本阶段**没有**接入任何路由或页面；以下为后续集成步骤（由集成方完成）：

1. **提供文件系统实现。** 调用方注入：
   - `listEntries(dir)`：递归列出目录，返回 `{path, size, mtimeMs}`；
   - `readHash(path, size)`：返回文件内容摘要的十六进制字符串（建议 sha256）。
   两个函数都应复用既有的路径白名单与 capability 检查。
2. **触发时机。** 建议作为**后台任务**调用：重复文件检测是 O(目录) 的 IO 密集操作，
   不要放在请求主链路上。既有 `task-manager.mjs` 的任务队列与事件流（Phase 146）
   可以直接承载这类长任务。
3. **执行归档前先出预览。** 把 `planArchive()` 的返回值原样交给 F11 整理预览界面：
   `moves` 逐条展示「源路径 → 目标路径 / 命中规则」，`skipped` 展示未处理原因，
   `freedBytes` 作为可释放空间。
4. **真正搬运另设一步。** 由用户确认计划后，再走一个**显式授权**的写入动作执行
   `moves`；该动作不属于本模块，且应遵守既有 `destructive` 风险等级的审批要求。
5. **索引状态展示（F24）。** `describeIndexState()` 的结果可直接渲染为
   「索引正常 / 索引已过期 / 索引状态未知」三态徽标，附 `indexedPaths`、
   `excludedCount` 与 `lastUpdatedAt`。
6. **权限感知搜索（F23）。** 待与搜索服务合并时，可用同一套 `listEntries`
   注入，把「当前会话无权访问的路径」直接排除在扫描范围之外。

## 8. 后续建议

1. 为 `detectDuplicates` 增加**内容校验**的第二判据（哈希一致后再抽样比对首尾字节），
   覆盖「哈希碰撞」这一理论上的误判。
2. `planArchive` 的规则目前是进程内参数，建议后续提供规则的持久化与界面编辑，
   让 F08/F09 的规则集可由用户维护。
3. 为 `groups` 增加**保留策略**建议（保留最新 / 保留最大 / 保留路径最短的一份），
   让 F11 预览能直接给出「建议删除哪一份」。
4. 索引状态（F24）可与 `document-index` 的实际扫描结果对接，
   用真实 `indexedPaths` 与 `dirty` 标记替代调用方传入的估计值。
5. 归档执行器应独立成模块并默认关闭，等 F11 预览与审批链路就绪后再启用。

# Phase 165 — 模型调用成本统计与能力配置

## 1. 背景：Marvis 对照

用户功能清单模块 11「本地模型、云端模型与隐私模式」拆成四个编号：

| 编号 | 名称 | 本阶段覆盖情况 |
| --- | --- | --- |
| AI05 | 隐私模式 | **覆盖**：`applyPrivacyMode()` 给出云端请求的允许 / 阻断判定 |
| AI07 | 模型能力配置 | **覆盖**：`describeModelCapabilities()` 描述上下文窗口、工具调用、结构化输出支持 |
| AI08 | 调用成本统计 | **覆盖**：`createUsageMeter()` 统计请求次数、Token 与估算成本 |
| AI09 | 超时与降级 | **不覆盖**：超时与降级链路由既有 `model-adapter.mjs` / `model-chat-adapter.mjs` 负责，本阶段不重复实现，只在能力描述里保留 `contextWindow` 等降级相关字段的承载位 |

Marvis 在模型设置页上给出「上下文长度 / 工具调用 / 结构化输出」三枚能力徽标，
并给出按模型维度的调用次数与 Token 消耗。本阶段实现这两个视图背后的**纯逻辑**，
不引入任何 Marvis 代码，也不改动被审计仓库的既有文件。

## 2. 变更边界

本阶段只新增三个文件：

| 文件 | 行数量级 | 作用 |
| --- | --- | --- |
| `apps/fnos-nas-agent/app/model-usage.mjs` | ~330 | 计量、成本估算、能力描述、隐私模式判定 |
| `tests/phase-165-model-usage.test.mjs` | ~230 | 24 个 node:test 用例 |
| `docs/phase-165-model-usage.md` | 本文件 | 阶段说明与集成指引 |

**未改动**：`server.mjs`、`app/ui/**`、`app/model-provider-store.mjs`、
`app/model-adapter.mjs`、`app/model-chat-adapter.mjs`、`docs/README.md`，
以及仓库内任何其它既有文件。没有新增 HTTP 路由，没有新增依赖。

## 3. 导出 API 约定

模块为纯 ESM，无副作用，无全局状态，无第三方依赖。

### 3.1 `estimateCost({ model, promptTokens, completionTokens, priceTable })`

估算一次模型调用的成本。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `model` | `string` | 模型 id，价格表的键 |
| `promptTokens` | `number` | 输入 Token，默认 `0` |
| `completionTokens` | `number` | 输出 Token，默认 `0` |
| `priceTable` | `object` | `{ "model-id": { inputPer1k, outputPer1k } }` |

返回 `{ cost, currency: "USD", priced, unit: "per-1k-tokens" }`。

- 价格表未命中 → `{ cost: 0, priced: false }`。
- 价格表命中但只给出单边价格 → 同样 `priced: false`，**不**做半边估算，避免
  静默低估成本。
- 模型 id 大小写不敏感：先精确匹配，再做小写匹配。

### 3.2 `describeModelCapabilities(entry)`

描述一个模型的能力。

| 字段 | 来源 | 缺省语义 |
| --- | --- | --- |
| `id` | `entry.id` | 缺失 → `null` |
| `provider` | `entry.provider` | 缺失 → `null` |
| `contextWindow` | `entry.contextWindow` | 缺失或非正整数 → `null` |
| `supportsTools` | `entry.capabilities.tools` | 未声明 → `false` |
| `supportsStreaming` | `entry.capabilities.streaming` | 未声明 → `false` |
| `supportsStructuredOutput` | `entry.capabilities.structuredOutput` | 未声明 → `false` |
| `privacyLocal` | `entry.local` | 未声明 → `false` |

**不臆造能力**：未声明的能力一律 `false`、未知的标识一律 `null`，由 UI 决定把
`false` 渲染成「不支持」还是「未知」。

### 3.3 `createUsageMeter({ maxEntries, now, priceTable, localProviders })`

创建一个有界内存的计量器。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `maxEntries` | `1000` | 环形缓冲容量，超出后丢弃最旧一条；必须为正整数，否则 `TypeError` |
| `now` | `() => Date.now()` | 时间戳来源 |
| `priceTable` | `{}` | 成本价格表 |
| `localProviders` | `[]` | 被视为「本地」的服务商名（大小写不敏感） |

返回：

| 方法 | 说明 |
| --- | --- |
| `record(entry)` | 记录一次调用；`entry` 形如 `{ provider, model, promptTokens = 0, completionTokens = 0, latencyMs = 0, outcome: "ok" \| "error", privacyMode = false }`。可选 `local: true` 或 `endpoint` 指向回环地址时判为本地请求。缺少 `provider` 的记录被丢弃并返回 `null` |
| `summary(options?)` | 汇总，见下表；`options.priceTable` 可临时覆盖价格表 |
| `byModel(options?)` | 按 `provider + model` 分组统计，返回按请求数降序排列的数组 |
| `entries()` | 返回环形缓冲内容的冻结副本（最旧在前） |
| `reset()` | 清空缓冲 |

`summary()` 返回：

| 字段 | 说明 |
| --- | --- |
| `requests` / `ok` / `error` | 请求总数与成功、失败计数 |
| `byOutcome` | `{ ok, error }` |
| `promptTokens` / `completionTokens` / `totalTokens` | Token 统计 |
| `estimatedCost` | 估算成本（USD，按 1k Token 计价） |
| `priced` | 全部记录都能定价才为 `true`；有一条缺价即为 `false` |
| `localRequests` / `cloudRequests` | 本地与云端请求数 |
| `privacyModeRequests` | 在隐私模式下发生的请求数 |
| `averageLatencyMs` | 平均耗时 |
| `unpricedModels` | 缺价的模型 id 列表（升序） |

### 3.4 `applyPrivacyMode(summary, { privacyMode })`

在汇总上叠加隐私模式判定，返回 `{ ...summary, privacyMode, cloudRequestsAllowed, cloudRequestsBlocked }`。

- 隐私模式关闭：`cloudRequestsAllowed === summary.requests`，`cloudRequestsBlocked === 0`。
- 隐私模式开启：**云端请求一律不计入 allowed**，全部计入 blocked。若汇总里只有
  云端请求，则 `cloudRequestsAllowed === 0`。
- 汇总未提供 `cloudRequests` 字段时，按「全部视为云端」处理（保守方向）。

## 4. 安全设计

1. **不落盘。** 本模块不写文件、不读文件，计量数据只存在于进程内存，随进程
   结束消失。
2. **不记录凭据。** 计量条目里没有 API Key 字段，也没有端点字段；`endpoint`
   仅在 `record()` 内部用于判断是否回环地址，不会进入条目、不会进入
   `summary()`、不会出现在 `entries()`。
3. **不外发。** 模块不发起任何网络请求，价格表由调用方在本地提供。
4. **未知即保守。** 隐私判定里无法区分本地与云端时，一律按云端处理；能力判定里
   未声明的能力一律 `false`。
5. **有界内存。** 环形缓冲的默认上限 1000 条，单条文本字段上限 160 字符，
   单个 Token 计数上限 10^9，避免异常输入撑爆内存。

## 5. 未改变的红线

- 未执行任何腾讯 Marvis 可执行文件，未复制 Marvis 源码；
- 未修改被审计仓库的任何既有文件（含 `server.mjs` 与 `app/ui/**`）；
- 未新增 HTTP 路由，未放宽任何鉴权 / 限流 / 白名单规则；
- 未修改后端密钥加密存储格式与主密钥机制；
- 未新增任何第三方依赖；
- 未执行 `git commit` / `git push`。

## 6. 测试清单

```bash
node --test tests/phase-165-model-usage.test.mjs
```

共 24 个用例，全部通过（`# pass 24 / # fail 0`）：

| # | 用例 | 覆盖点 |
| --- | --- | --- |
| 1 | estimateCost prices a known model from the price table | 命中价格表的成本估算 |
| 2 | estimateCost reports priced=false for a model that is not in the price table | 未命中 → `priced: false` |
| 3 | estimateCost matches a model id case insensitively | 模型 id 大小写不敏感 |
| 4 | estimateCost rejects a price entry that only knows one side | 单边价格不半估算 |
| 5 | estimateCost treats missing input as zero cost and unpriced | 缺参数语义 |
| 6 | describeModelCapabilities keeps unknown values null or false | 缺字段 → `null` / `false` |
| 7 | describeModelCapabilities reports declared capabilities | 已声明能力如实返回 |
| 8 | describeModelCapabilities does not invent a context window | `contextWindow: 0` 不被当成已知窗口 |
| 9 | createUsageMeter records a call and summarizes it | 记录 + 汇总（请求数、Token、成本） |
| 10 | createUsageMeter counts an error outcome separately | `byOutcome` 成功 / 失败分流 |
| 11 | createUsageMeter drops the oldest entry when the ring buffer is full | **环形缓冲上限**：丢最旧 |
| 12 | createUsageMeter keeps the default buffer bound | 默认上限 1000 条 |
| 13 | createUsageMeter rejects an invalid buffer size | 非法 `maxEntries` 抛 `TypeError` |
| 14 | createUsageMeter ignores a record without a provider | 缺 `provider` 的记录被丢弃 |
| 15 | createUsageMeter reports priced=false when a model has no price | 混合定价 → `priced: false` + `unpricedModels` |
| 16 | createUsageMeter groups usage per model | 按模型分组统计 |
| 17 | createUsageMeter marks a loopback endpoint as local | 回环端点判为本地 |
| 18 | createUsageMeter treats a configured local provider as local | `localProviders` 配置生效 |
| 19 | createUsageMeter reset clears the buffer | `reset()` |
| 20 | applyPrivacyMode blocks cloud requests while privacy mode is on | **隐私模式阻断云端请求** |
| 21 | applyPrivacyMode allows every request when privacy mode is off | 关闭隐私模式时不阻断 |
| 22 | applyPrivacyMode allows nothing when every request is a cloud request | 全云端流量 → `allowed === 0` |
| 23 | applyPrivacyMode treats an unknown breakdown as cloud traffic | 未知分流按云端处理 |
| 24 | applyPrivacyMode keeps the summary fields it received | 透传原汇总字段 |

## 7. 集成说明

本阶段**没有**接入页面与后端路由；以下为后续集成步骤（由集成方在
`app/ui/pages.js`、`app/server.mjs` 与 `app/model-provider-store.mjs` 中完成）：

1. **计量点。** 在模型调用的唯一出口打点最省事：
   - `model-chat-adapter.mjs` 的直聊请求返回处；
   - `model-adapter.mjs` 的 `requestOne()` 成功解析 usage 之后
     （`:382-385` 已经统计了 `inputTokens` / `outputTokens`）。
   记一条：

   ```js
   import { createUsageMeter } from "./model-usage.mjs";
   const usage = createUsageMeter({ maxEntries: 1000, priceTable: PRICE_TABLE });
   // 一次调用结束后
   usage.record({
     provider: config.providerName,
     model: config.model,
     promptTokens: envelope.usage?.prompt_tokens ?? 0,
     completionTokens: envelope.usage?.completion_tokens ?? 0,
     latencyMs: Date.now() - startedAt,
     outcome: "ok",
     privacyMode: privacyModeEnabled
   });
   ```

2. **价格表来源。** 价格表属于运维配置，建议由 `model-provider-store.mjs` 的
   `dataDir` 同目录落一个 `model-prices.json`，启动时读入并注入
   `createUsageMeter({ priceTable })`；本阶段不实现落盘逻辑。

3. **暴露给 UI。** 在 `server.mjs` 的模型区（`/api/models` 附近）增加一个只读
   路由，例如 `GET /api/models/usage`，返回
   `{ summary, byModel, privacy: applyPrivacyMode(summary, { privacyMode }) }`；
   路由需要沿用既有的会话校验与同源校验。

4. **UI 挂载点。**
   - 「模型服务」页（`app/ui/index.html:419-499`）可在 `#model-provider-metrics`
     下方新增一块「调用成本统计」：请求次数、输入 / 输出 Token、估算成本、
     平均耗时；缺价模型显示「未配置价格」。
   - 能力配置徽标可挂在既有服务商卡片（`app/ui/pages.js:83-207` 渲染的
     `.card`）上：上下文窗口、工具调用、结构化输出三枚徽标，`false` 时渲染
     「未知 / 未声明」而不是「不支持」。
   - 隐私模式开关沿用既有「执行模式」控制台（`app/ui/pages.js:938-960`）的
     交互形态，但落点必须是后端开关，不能只在前端隐藏云端服务商。

5. **AI09 的位置。** 超时与降级仍由 `model-adapter.mjs` 的候选链
   （`buildCandidates()` :260-280、`requestOne()` :315-429）负责。本模块不改动
   降级行为；`privacyMode` 只是给计量条目打的标记，供 UI 显示「在隐私模式下
   发生的调用」。

## 8. 后续建议

1. 把 `priceTable` 抽成可热更新的结构，价格变更后不必重启进程。
2. `summary()` 目前的 `estimatedCost` 是进程生命周期内的累计值；若需要
   「今日 / 本小时」维度，可在计量器外再挂一层按时间桶的聚合。
3. `describeModelCapabilities()` 的 `contextWindow` 目前完全依赖调用方声明；
   若能从模型目录（`discoverModels()` 返回的 `models[]`）反查上限，可让
   AI07 的徽标更完整。
4. 若要把「隐私模式」变成硬约束，建议在 `model-adapter.mjs` 的
   `requestOne()` 入口加一道 provider 判定，而不是只在计量层统计——统计层
   只能记录既成事实，挡不住已经发出的请求。
5. 文档索引 `docs/README.md` 需要由持有该文件写权限的一方补充本阶段条目并
   更新文档计数（发布门禁 `scripts/check-release-gates.mjs` 会校验索引中的
   文档数量与实际文件数一致）。

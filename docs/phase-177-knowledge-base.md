# Phase 177 — 运维知识库与长期记忆

本阶段实现《FNOS_NAS_Agent_Marvis 功能借鉴清单》模块 12「个人知识库与长期记忆」的服务端**纯逻辑层**，
覆盖清单编号 **K03、K04、K05、K08、K09、K10**。

本模块把「已经踩过的坑」沉淀成可检索、可复核、可纠错的长期记忆，并给出一条硬边界：
**长期记忆永远不覆盖实时状态**。知识条目里记录的版本、容量一类事实只是「某个时刻的观测」，
读取时必须带着采集时间一起出现，绝不能被当成当前值直接使用。

本阶段**不做 UI**（由 lead 接线），**不改** `server.mjs` / `README.md` / `docs/README.md`。

## 1. 变更边界

本阶段**只新增**三个文件：

| 文件 | 作用 |
| --- | --- |
| `apps/fnos-nas-agent/app/knowledge-base.mjs` | ES module，纯逻辑层，零 import、零 I/O、零第三方依赖 |
| `tests/phase-177-knowledge-base.test.mjs` | `node --test` 用例（33 个） |
| `docs/phase-177-knowledge-base.md` | 本文档 |

明确**没有**发生的事：

- 没有修改任何既有生产模块（含 `server.mjs`、`app/audit-log.mjs`、`app/tool-registry.mjs`、
  `app/execution-policy.mjs`、`app/permission-policy.mjs`）与 UI；
- 没有新增、修改或删除任何 HTTP 路由；
- 没有修改 `README.md` / `docs/README.md` / 发布门禁脚本（索引同步由 lead 统一做）；
- 没有引入任何第三方依赖，也没有 `import` 任何内置模块
  （`node:child_process` / `node:http` 一律未使用）；
- 没有执行 `git commit` / `git push`。

本模块**不执行**任何命令、不做任何文件 I/O、不调用任何模型、不提供任何删除 NAS 数据的接口
（只有「归档」`archive`，归档后条目仍留在库内可查）。

## 2. 导出 API 契约

```js
import {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_STALE_AFTER_MS,
  KNOWLEDGE_OPERATIONS,
  KNOWLEDGE_SOURCES,
  KNOWLEDGE_VERIFICATION_STATES,
  MAX_BODY_LENGTH,
  MAX_SEARCH_LIMIT,
  MAX_SUMMARY_LENGTH,
  createKnowledgeBase,
  compareKnowledgeFacts,
  detectKnowledgeConflicts,
  evaluateKnowledgeExpiry,
  inspectKnowledgeBody,
  normalizeKnowledgeEntry,
  redactKnowledgeText,
  referenceKnowledgeEntry,
  reviewKnowledgeUpdates,
  searchKnowledgeEntries
} from "../apps/fnos-nas-agent/app/knowledge-base.mjs";
```

### 2.1 常量

| 导出 | 取值 | 说明 |
| --- | --- | --- |
| `KNOWLEDGE_SOURCES` | `["official-doc","field-observation","manual-confirmation"]` | K03 来源枚举 |
| `KNOWLEDGE_VERIFICATION_STATES` | `["verified","unverified","stale","conflicted"]` | 验证状态枚举 |
| `KNOWLEDGE_OPERATIONS` | `["write","verify","archive"]` | 支持的写操作 |
| `DEFAULT_MAX_ENTRIES` | `500` | 库容量上限 |
| `DEFAULT_STALE_AFTER_MS` | `2592000000`（30 天） | 未验证条目的陈旧阈值 |
| `DEFAULT_SEARCH_LIMIT` / `MAX_SEARCH_LIMIT` | `20` / `50` | 检索分页上限 |
| `MAX_BODY_LENGTH` | `8000` | 正文长度上限 |
| `MAX_SUMMARY_LENGTH` / `MAX_TITLE_LENGTH` | `300` / `200` | 摘要 / 标题上限 |
| `MAX_TAGS` / `MAX_FACTS` / `MAX_VERSIONS` | `20` / `30` / `20` | 标签 / 事实 / 版本上限 |

### 2.2 纯函数

| 导出 | 签名 | 返回 |
| --- | --- | --- |
| `redactKnowledgeText` | `(value: string) => {text, fields[]}` | 脱敏；只回报字段名，不回显密钥原文 |
| `inspectKnowledgeBody` | `(body: string) => {ok:true, reasons[]} \| {ok:false, code, message, reasons?}` | 正文安全检查（提示词 / 异常栈 / 绝对路径） |
| `normalizeKnowledgeEntry` | `(input, {now, id}) => {ok:true, entry, warnings[], redactedFields[]} \| {ok:false, code, message}` | 规范化一条知识 |
| `referenceKnowledgeEntry` | `(entry, {now}) => {ok:true, reference} \| {ok:false, code, message}` | 生成引用视图（未验证 ⇒ 推测） |
| `compareKnowledgeFacts` | `(entry, current, {now}) => {ok:true, stale, changed[], missing[], asOf, note}` | K05 事实与当前值比对 |
| `searchKnowledgeEntries` | `(entries, query, {limit}) => {ok:true, total, limit, entries[]}` | K04 检索 |
| `detectKnowledgeConflicts` | `(entries, {topic}) => {ok:true, conflicts[], total}` | K10 冲突检测 |
| `reviewKnowledgeUpdates` | `(entries, current, {now}) => {ok:true, changed[], total, checkedAt}` | K09 更新提示 |
| `evaluateKnowledgeExpiry` | `(entries, {now, staleAfterMs}) => {ok:true, expired[], stale[], checkedAt}` | K10 过期判定 |

### 2.3 知识库门面

`createKnowledgeBase({ storage = null, maxEntries = 500, staleAfterMs = 30d, now = () => ISO, id = "kb-entry" })`

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `preview` | `(operation, input) => {ok, previewId, operation, entry, warnings[], redactedFields[], existing, requiresForce}` | **第一步**：预览，不落库 |
| `commit` | `(previewId) => {ok, written:true, entry}` | **第二步**：提交此前预览过的写操作 |
| `cancel` | `(previewId) => {ok, cancelled:true}` | 放弃预览 |
| `list` | `({limit, offset, includeArchived}) => {ok, total, limit, offset, entries[]}` | 列出（默认不含归档） |
| `get` | `(id) => {ok, entry} \| {ok:false, code:"knowledge-not-found"}` | 读取单条 |
| `search` | `(query, options) => {ok, total, limit, entries[]}` | 检索 |
| `reference` | `(id) => {ok, reference}` | 引用视图（推测标记） |
| `compare` | `(id, current) => {ok, stale, changed[], ...}` | 事实比对 |
| `review` | `(current) => {ok, changed[], total}` | 更新提示清单 |
| `conflicts` | `() => {ok, conflicts[], total}` | 冲突清单 |
| `refreshExpiry` | `() => {ok, expired[], stale[], conflicts[]}` | 刷新过期 / 陈旧 / 冲突标记 |
| `stats` | `() => {ok, total, archived, bySource, byVerification, maxEntries, staleAfterMs, pendingPreviews}` | 分布汇总 |

`entry` 结构：

```js
{
  id, title, topic, conclusion, summary, body, category, source, verification,
  confidence, speculative, tags[], facts[{name, value, collectedAt, stale}],
  collectedAt, updatedAt, expiresAt, versions[], conflicts[], stale, expired,
  archived, redactedFields[]
}
```

### 2.4 存储注入

`storage` 是可选的可注入接口，默认内存实现：

```js
createKnowledgeBase({
  storage: {
    load: () => [/* 条目数组 */],   // 创建时调用一次
    save: (entries) => { /* 持久化 */ }  // 每次 commit 后调用
  }
});
```

`load()` 返回的数组里每条必须有字符串 `id`，否则被忽略。默认（不传 `storage`）时
`save` 不会被调用，数据只存在于内存，进程退出即丢失。

## 3. 语义要点

### 3.1 K03 — 来源与可信度

- 每条记录必须声明 `source`（`official-doc` / `field-observation` / `manual-confirmation`），
  非法值返回 `knowledge-invalid-source`；
- 每条记录必须带 `collectedAt`（采集时间）与 `verification`（验证状态），
  非法验证状态返回 `knowledge-invalid-verification`；
- 可信度 `confidence` 由来源推导：官方文档与人工确认 = `high`，现场观测 = `medium`；
- **未验证条目在引用时必须标记为「推测」**：`referenceKnowledgeEntry()` 对
  `verification !== "verified"` 的条目返回 `speculative: true`、`label: "推测"`、
  `confidence: "speculative"`，并在 `warning` 里写明「该条目尚未验证，引用时必须标注为推测」；
  检索结果里未验证条目的 `confidence` 同样是 `speculative`，且排序上排在已验证条目之后。

### 3.2 K04 — 检索与排序

- 过滤维度：`keyword`（在标题、摘要、正文、标签里做大小写不敏感子串匹配）、
  `tag`、`category`、`source`；
- 返回字段固定为 `id`、`title`、`summary`、`source`、`confidence`、`updatedAt`，
  另附 `speculative`、`verification`、`stale`、`expired`、`collectedAt`；
- **有上限**：`limit` 被夹在 `1..50`（`MAX_SEARCH_LIMIT`）之间；**有去重**：同 `id` 只出现一次；
- 排序：已验证在前，同组内按 `updatedAt` 倒序，再按 `id` 字典序。

### 3.3 K05 — 与实时状态分离

- 条目里的版本 / 容量一类事实放在 `facts[]`，**每条事实必须带 `collectedAt`**；
- 引用时事实被放进 `factsAsOf[]`，只给 `name` / `value` / `collectedAt` / `stale`，
  绝不伪装成当前值；
- `compareKnowledgeFacts(entry, current)` 把记录值与当前值比对，返回
  `stale`（是否可能过期）、`changed[]`（含 `recordedValue` 与 `currentValue`）、
  `missing[]`（当前值里已不存在的项）、`asOf`（采集时间），并固定附带说明
  「记录值仅代表采集时刻的观测，不代表当前状态」；
- `current` 缺某个事实时记为 `missing`（同样触发 stale），不会静默当作一致。

### 3.4 K08 — 文档沉淀（写入）

写入必须满足：

- **两步接口**：`preview("write", input)` → `commit(previewId)`。预览阶段不落库，
  `preview` 返回的 `entry` 就是将要写入的内容，`commit` 之后条目才可见；
- **脱敏**：正文与摘要里的疑似密钥被抹除（见 §5），只回报字段名
  （`redactedFields[]`），并给出 `secret-material-redacted` 警告；
- **正文长度上限** `MAX_BODY_LENGTH = 8000`，超出返回 `knowledge-body-too-long`；
- **拒绝覆盖同 id**：直接写已存在的 `id` 返回 `knowledge-duplicate-id`；
  必须显式 `force: true` 才能覆盖，且覆盖时**记录版本**：旧条目摘要进
  `versions[]`（`{version, at, title, summary, verification}`，上限 20 条）；
- 库里条目数超过 `maxEntries` 时丢弃**最旧**的一条（历史优先保留）。

### 3.5 K09 — 知识更新提示

`reviewKnowledgeUpdates(entries, current)` / `base.review(current)`：
把当前配置 / 版本值与条目里记录的事实比对，凡是「变了」「当前值里没有了」
或「条目已被标 stale」的，都进入 `changed[]`，每条带 `changedFacts[]`、
`missingFacts[]`、`collectedAt` 与提示语「配置或版本已变化，建议复核该条目」。

### 3.6 K10 — 冲突与过期

- **冲突**：按 `topic` 分组，同一主题下出现不同 `conclusion` 时返回冲突项，
  列出全部参与条目（`id` / `title` / `conclusion` / `source` / `verification` /
  `collectedAt`），`resolution` 固定为 `null`——**不自动取舍、不随便选一个**，
  只给 `note`「同一主题存在冲突结论，未做自动取舍」；
- **过期**：`expiresAt` 已到 ⇒ 进入 `expired[]`；未验证且采集时间超过
  `staleAfterMs`（默认 30 天）⇒ 进入 `stale[]`；
- `refreshExpiry()` 只**打标记**：`entry.expired` / `entry.stale` 置位，
  过期条目的 `verification` 由 `unverified` 降级为 `stale`，冲突条目的
  `verification` 由 `verified` 降级为 `conflicted`，`entry.conflicts[]` 记录
  冲突主题与对手条目 id。**不删除条目、不改写结论内容**。

## 4. 安全边界

| 边界 | 实现位置 |
| --- | --- |
| 正文不保存提示词原文 | `inspectKnowledgeBody()` 拒绝 `<\|im_start\|>`、`system prompt`、`### Instruction`、`"role": "system"` 等标记 |
| 正文不保存异常栈 | `inspectKnowledgeBody()` 拒绝 `at fn (file:12:3)` 形态的栈帧 |
| 正文不保存绝对本机路径 | `inspectKnowledgeBody()` 拒绝 `/home/...`、`/Users/...`、`C:\...`、`\\server\share` 等绝对路径 |
| 密钥不落原文 | `redactKnowledgeText()` 替换为 `[已隐藏]` / `[已隐藏令牌]`，只回报字段名 |
| 写操作必须先预览后提交 | `preview()` / `commit()` / `cancel()` 三段式；`commit` 只认已存在的 `previewId` |
| 不提供删除 NAS 数据的接口 | 本模块无任何文件 / NAS 写操作，只有 `archive` 归档标记 |
| 无命令执行、无网络 | 无 `import`、无 `node:child_process`、无 `node:http`、无 I/O |
| 错误结构化 | 统一 `{ok:false, code, message, ...}`，不抛裸异常（仅构造参数非法抛 `TypeError`） |

## 5. 脱敏规则

- **按字段名**：`apiKey` / `api_key` / `accessKey` / `secret` / `clientSecret` /
  `refreshToken` / `authToken` / `bearer` / `token` / `password` / `passwd` / `pwd` /
  `passphrase` / `credential` / `privateKey` / `sessionId` / `cookie`，
  以及中文 `密码` / `口令` / `密钥` / `令牌` / `凭证` / `授权码` / `私钥`；
  形如 `name: value` / `name=value` 的取值替换为 `[已隐藏]`；
- **按令牌形态**：`sk-…` / `ghp_…` / `github_pat_…` / `AKIA…` / `AIza…` /
  `xox?-…` / JWT，整体替换为 `[已隐藏令牌]`；
- 被触碰的字段名汇总进 `redactedFields[]`，便于审计「这份知识脱敏过什么」。

## 6. 有界性

| 维度 | 上限 |
| --- | --- |
| 库容量 | `maxEntries`（默认 500），超出丢弃最旧一条 |
| 正文 | 8000 字符 |
| 摘要 / 标题 | 300 / 200 字符 |
| 标签 | 20 个（去重后小写排序） |
| 事实 | 30 条 |
| 版本 | 20 条 |
| 冲突 | 20 条（`MAX_CONFLICTS` 常量） |
| 检索返回 | 50 条 |

## 7. 测试结果

```
node --test tests/phase-177-knowledge-base.test.mjs
```

**33 个用例，33 通过，0 失败。**

| 用例 | 覆盖点 |
| --- | --- |
| 常量与枚举 | 来源 / 验证状态 / 上限常量 |
| K03 规范化 | 来源、采集时间、验证状态落库 |
| K03 非法来源 | 结构化拒绝 |
| K03 未验证 → 推测 | 引用返回 `label: "推测"`、`confidence: "speculative"`、推测警告 |
| K03 已验证引用 | 无推测标签 |
| K04 多维过滤 | keyword / tag / category / source |
| K04 字段与上限去重 | 返回字段齐全、limit 生效、id 去重 |
| K04 排序 | 已验证在前，未验证 `confidence` 为推测 |
| K05 事实采集时间 | `facts[].collectedAt` / `factsAsOf[].collectedAt` |
| K05 版本变化 | `stale: true` 且给出 `recordedValue` / `currentValue` |
| K05 未变化 | `stale: false` |
| K08 正文超长 | `knowledge-body-too-long` |
| K08 字段名密钥 | 原文消失，字段名回报 |
| K08 令牌形态 | `sk-…` 被抹除 |
| K08 写入时脱敏 | `redactedFields` 含 `apiKey` |
| K08 正文三类禁项 | 提示词 / 异常栈 / 绝对路径分别被拒 |
| K08 两步写入 | 预览不落库、提交后可见 |
| K08 拒绝覆盖 / force | `knowledge-duplicate-id`；force 后 `versions` 记录 v1 |
| K08 取消预览 | 取消后提交报 `knowledge-preview-not-found` |
| K09 更新提示 | 未变 → 0 条；变化 → 1 条带 `changedFacts` |
| K09 纯函数 | 单独调用亦可 |
| K10 冲突 | 同主题不同结论 → 冲突项，`resolution: null` |
| K10 无冲突 | 0 项 |
| K10 过期 | `expiresAt` 到期 → `expired[]` |
| K10 陈旧 | 长期未验证 → `stale[]` |
| K10 refreshExpiry | 过期 + 冲突标记同时刷新，验证状态降级 |
| 归档 | 两步接口，归档后不出现在 list / search |
| 验证变更 | 两步接口，`speculative` 正确翻转 |
| 非法输入 | 非法操作 / 未知 id / 未知 previewId 均结构化报错 |
| 存储注入 | `load` 条目可查，`save` 被调用 |
| 容量淘汰 | 超过 `maxEntries` 丢弃最旧 |
| 构造参数 | 三种非法参数抛 `TypeError` |
| stats | 来源 / 验证状态分布 |

## 8. 留给 lead 的接线点

### 8.1 建议的 HTTP 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/knowledge` | 列出条目（`limit` / `offset` / `includeArchived`） |
| `GET` | `/api/knowledge/search` | 检索（`keyword` / `tag` / `category` / `source`） |
| `GET` | `/api/knowledge/:id` | 读取单条 |
| `GET` | `/api/knowledge/:id/reference` | 引用视图（推测标记，`speculative` / `label`） |
| `GET` | `/api/knowledge/:id/compare?version=…` | 事实与当前值比对（`stale` 标志） |
| `POST` | `/api/knowledge/preview` | **第一步**：预览写入（返回 `previewId`） |
| `POST` | `/api/knowledge/commit` | **第二步**：提交写入（`previewId`） |
| `POST` | `/api/knowledge/:id/verify` | 预览 + 提交验证状态变更 |
| `POST` | `/api/knowledge/:id/archive` | 预览 + 提交归档 |
| `GET` | `/api/knowledge/review` | K09 需要复核的条目清单 |
| `GET` | `/api/knowledge/conflicts` | K10 冲突清单 |
| `GET` | `/api/knowledge/stats` | 分布统计 |

接线注意：

- 写入路由**必须**拆成 preview / commit 两步，不能合成一个「一次提交」的接口；
- `previewId` 属于短期令牌，建议设 TTL（当前实现不自动过期，进程内有效）；
- `compare` / `review` 的 `current` 值应来自实时状态读取（`model-provider-store`、
  `diagnostic-evidence` 等），**不要**把知识库里的记录值当作当前值回灌。

### 8.2 建议的 UI 面板位置

- 在 `app/ui/pages.js` 的侧边导航新增「知识库」入口，与「诊断」「工具」同级；
- 列表页展示：标题、来源徽标（官方文档 / 现场观测 / 人工确认）、验证状态徽标、
  更新时间、推测标记；未验证条目用显著色标出；
- 条目详情页固定展示「采集时间」与「事实快照（截至 …）」，并对 `stale` 条目显示
  「可能已过期，请复核」提示；
- 「需要复核」面板直接渲染 `review()` 返回的 `changed[]`；
- 「冲突」面板展示冲突组内全部条目，**不提供**「自动选一个」的按钮；
- 写入表单只允许填写标题 / 摘要 / 正文 / 来源 / 标签 / 类别 / 事实，
  并在预览阶段展示脱敏结果与 `redactedFields`，确认后再提交。

### 8.3 索引同步

`docs/README.md` 与 `README.md` 的能力清单需要登记本阶段（按 lead 的统一流程执行）。
另需注意 `scripts/check-release-gates.mjs` 会统计 `docs/` 下的文档数量，
新增 `docs/phase-177-knowledge-base.md` 会改变该计数。

## 9. 后续建议

1. **持久化**：把 `storage` 接口接到仓库既有的原子写 + 串行写队列做法
   （参考 `app/runbook-store.mjs`），让记忆跨重启保留；
2. **审核流**：把「现场观测 → 人工确认」的提升路径接进 `verify` 流程，
   每次提升留痕（谁、何时、把哪条从 `unverified` 提到 `verified`）；
3. **相似度与去重**：目前是精确子串匹配，可引入标签共现的粗排；
4. **过期复核提醒**：把 `refreshExpiry()` 接到 `scheduled-health-checks` 的调度器上；
5. **导出**：提供知识库导出（脱敏后 JSON）以便离线归档。

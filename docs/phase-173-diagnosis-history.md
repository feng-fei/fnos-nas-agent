# Phase 173 — 诊断历史与知识修正

本阶段实现用户功能清单中模块 03「AI 故障诊断与自动修复」的**沉淀层**，覆盖对照表里的
K08（过期信息管理）、K09（记忆修正）、K10（知识更新提示）、D13（诊断历史）、D14（结果沉淀）。

Phase 162 的 `app/diagnostics.mjs` 能产出一份诊断报告，Phase 167 的
`app/diagnostic-evidence.mjs` 能把仓库里的审计记录、工具轨迹、巡检状态与系统快照整理成证据，
但两者的结论都是**一次性的**：诊断做完就蒸发了。本模块给诊断结论一个有界的记忆。

本阶段实现三件事：

1. **历史**：诊断结论被记录下来（症状、候选原因、证据引用、采取的动作、结论状态、备注）；
2. **过期**：超过阈值且仍未闭环的条目会被标记为过期，并给出「建议复核或归档」的提示；
3. **修正**：人工修正被记录成**追加式**的修正事件，原始条目保留，全程可追溯。

## 1. 变更边界

本阶段**只新增**三个文件：

| 文件 | 作用 |
| --- | --- |
| `apps/fnos-nas-agent/app/diagnosis-history.mjs` | ES module，纯内存实现，无 I/O、无第三方依赖 |
| `tests/phase-173-diagnosis-history.test.mjs` | `node --test` 用例 |
| `docs/phase-173-diagnosis-history.md` | 本文档 |

明确**没有**发生的事：

- 没有修改任何既有生产模块（含 `server.mjs`、`app/diagnostics.mjs`、
  `app/diagnostic-evidence.mjs`、`app/runbook-store.mjs`）与 UI；
- 没有新增、修改或删除任何 HTTP 路由；
- 没有修改 `README.md` / `docs/README.md` / 发布门禁脚本（索引同步由 lead 统一做）；
- 没有引入任何第三方依赖；
- 没有执行 `git commit` / `git push`。

本模块**不执行**任何命令、不做文件 I/O、不调用任何模型。

## 2. 导出 API 契约

```js
import {
  DEFAULT_MAX_DIAGNOSIS_ENTRIES,
  DEFAULT_STALE_AFTER_MS,
  DIAGNOSIS_OUTCOMES,
  MAX_SYMPTOM_LENGTH,
  createDiagnosisHistory,
  redactDiagnosisText
} from "../apps/fnos-nas-agent/app/diagnosis-history.mjs";
```

| 导出 | 签名 / 取值 | 说明 |
| --- | --- | --- |
| `DEFAULT_MAX_DIAGNOSIS_ENTRIES` | `200` | 默认保留的条目数上限 |
| `DEFAULT_STALE_AFTER_MS` | `604800000`（7 天） | 默认过期阈值 |
| `DIAGNOSIS_OUTCOMES` | `["open","resolved","ignored"]` | 结论状态取值 |
| `MAX_SYMPTOM_LENGTH` | `2048` | 症状长度上限（2 KiB） |
| `redactDiagnosisText(value)` | `(string) => {text, fields[]}` | 脱敏工具，报告被触碰的字段名 |
| `createDiagnosisHistory(options)` | 见下 | 创建诊断历史库 |

`createDiagnosisHistory({ maxEntries = 200, staleAfterMs = 7d, now, id })` 返回：

| 方法 | 签名 | 返回 |
| --- | --- | --- |
| `record` | `(entry) => {recorded:true, entry} \| {recorded:false, reason, code}` | 写入一条诊断历史 |
| `list` | `({symptom?, limit?, offset?}) => {entries[], total, limit, offset}` | 列出历史，默认按时间倒序 |
| `get` | `(id) => entry \| null` | 读取单条 |
| `update` | `(id, patch) => {updated:true, entry} \| {updated:false, reason, code}` | 更新状态 / 备注 / 原因 / 动作 / 证据引用 |
| `remove` | `(id) => {removed:true, id} \| {removed:false, reason, code}` | 删除一条 |
| `markStale` | `(id) => {stale:true, entry, prompt, alreadyStale} \| {stale:false, reason, code}` | 标记过期并给出复核提示 |
| `suggestCorrections` | `({symptom, limit?}) => {suggestions[], total, limit}` | 针对症状给出复核 / 更新提示 |
| `applyCorrection` | `(id, {outcome, note, correctedBy}) => {corrected:true, entry, correction} \| {corrected:false, reason, code}` | 追加一条修正事件 |
| `stats` | `() => {total, byOutcome, stale, bySymptom[], maxEntries, staleAfterMs}` | 分布汇总 |

`entry` 的字段：

```js
{
  id, symptom, causes[], evidenceRefs[], actions[], outcome, note,
  createdAt, updatedAt, stale, staleAt, stalePrompt,
  corrections[], redactedFields[]
}
```

## 3. 过期与修正的语义

### 过期（K08 / K10）

- 判定条件：条目创建至今**超过** `staleAfterMs`（默认 7 天）**且**结论仍为 `open`；
  刚好等于 7 天不算过期（严格大于）。
- `markStale()` **只打标记**：
  - 不自动删除条目；
  - 不自动修改结论（`open` 仍是 `open`）；
  - 只写 `stale: true`、`staleAt` 与 `stalePrompt`（文案为「建议复核或归档」）。
- 已 `resolved` / `ignored` 的条目不会过期——它们已经闭环，没有复核的必要。
- 重复调用 `markStale()` 是幂等的，`alreadyStale` 为 `true` 且 `staleAt` 不变。
- `suggestCorrections()` 会把过期条目与其它命中同症状的条目一起返回，每条带
  `prompt`（提示语）与 `reason`（依据），供上层做「知识更新提示」。

### 修正（K09 / D14）

- `applyCorrection(id, {outcome, note, correctedBy})` 记录一条**修正事件**：

  ```js
  { id, at, previousOutcome, outcome, note, correctedBy }
  ```

  事件里同时保留修正前后的结论、发生时间与原因。
- **原始条目不被抹掉**：症状、候选原因、证据引用、动作全部保留，修正痕迹只追加在
  `corrections[]` 里，便于回溯「当初为什么这么判、后来为什么改」。
- 修正后条目的 `outcome` 更新为修正后的值；修正事件本身仍记录着 `previousOutcome`。
- 修正事件条数上限 50，超出后丢弃最旧的修正痕迹（条目本身仍在）。

## 4. 脱敏

诊断历史会被人读到，所以症状与备注里疑似密钥的片段**不得原样入库**。脱敏思路与
`app/runbook-store.mjs` 的 `redactRunbookText()` 一致：

- **按字段名判断**：`apiKey` / `token` / `secret` / `password` / `authorization` /
  `cookie` / `credential` / `private` / `bearer` / `sessionId` / `access-key` /
  `refresh-key` 等命名的字段，其取值被替换成 `[已隐藏]`；
- **中文同样识别**：`密码` / `口令` / `密钥` / `令牌` / `凭证` / `授权` 命名的字段同样脱敏；
- **无字段名的密钥形态**：`sk-…` / `ghp_…` / `github_pat_…` / `AKIA…` / `AIza…` /
  JWT 等整体替换成 `[已隐藏令牌]`；
- 被触碰的字段名记录在条目的 `redactedFields[]` 里，便于审计「这份历史脱敏过什么」。

脱敏同时作用于 `symptom`、`note`、`causes[]`、`evidenceRefs[]`、`actions[]`，
以及 `applyCorrection()` 的 `note` 与 `correctedBy`。

## 5. 有界性

| 维度 | 上限 |
| --- | --- |
| 条目数 | `maxEntries`（默认 200），超出丢弃**最旧**的一条 |
| 症状长度 | 2048 字符（2 KiB） |
| 备注长度 | 1024 字符 |
| 候选原因 / 动作 | 各 50 条，每条 512 字符 |
| 证据引用 | 50 条，每条 256 字符 |
| 修正事件 | 50 条 |
| `list()` 分页 | 默认 50，上限 200 |

条目被丢弃时是「最旧」而不是「最新」——历史的价值在于保留更早的结论。

## 6. 测试结果

```
node --test tests/phase-173-diagnosis-history.test.mjs
```

**21 个用例，21 通过，0 失败。**

| 用例 | 覆盖点 |
| --- | --- |
| 常量约定 | 默认上限、7 天阈值、结论状态枚举 |
| 写入与读取 | `record()` 后 `get()` 能读回全部字段 |
| 非法写入 | 空症状、超长症状、非法结论状态被拒 |
| 边界裁剪 | 超出 `maxEntries` 丢弃最旧条目 |
| 症状过滤与分页 | `list({symptom})` 过滤、`limit`/`offset` 分页 |
| 更新 | 改结论与备注；非法结论与不存在条目被拒 |
| 删除 | 正常删除与不存在条目报错 |
| 过期标记 | 超 7 天的 open 条目被标记并给出提示，结论未被改、条目未被删 |
| 过期边界 | 刚好 7 天不算过期，超过 1 毫秒才算 |
| 闭环条目不过期 | `resolved` / `ignored` 不被标记过期 |
| 幂等 | 重复 `markStale()` 不改 `staleAt` |
| 修正追加 | 修正事件含前后结论与原因，原始条目保留 |
| 修正非法输入 | 不存在条目与非法结论被拒 |
| 提示生成 | `suggestCorrections()` 按症状给出「已解决 / 建议复核或归档」等提示 |
| 空症状提示 | 返回空结果 |
| 统计 | 总数、open/resolved/ignored 分布、过期数、症状聚合与排序 |
| 脱敏 | 症状与备注中的密钥被抹除，`redactedFields` 非空 |
| 脱敏工具 | `redactDiagnosisText()` 直接可用并报告字段名 |
| 非法入参 | `record` 的各种非法输入被安全拒绝 |
| 构造参数 | `maxEntries` / `staleAfterMs` / `now` / `id` 非法时抛 `TypeError` |

## 7. 遗留限制

- **没有持久化**：数据只存在于内存里，进程重启即丢失。后续需要落盘时，可参考
  `app/runbook-store.mjs` 的写入队列 + 原子替换做法。
- **没有前端入口**：目前没有任何 UI 或 HTTP 路由能展示历史、过期提示与修正记录；
  `server.mjs` 的接线由 lead 统一做。
- **过期是"提示"而不是"结论"**：模块不会自动判断「结论已经错了」，只把可能过期的
  open 条目标出来并提示复核，结论的权威仍在人。
- **修正不覆盖结论来源**：修正事件只追加、不删除；如果需要撤销修正，当前没有
  「撤销修正」接口，只能再追加一条相反的修正。
- **症状匹配是子串匹配**：`list({symptom})` 与 `suggestCorrections()` 使用大小写不敏感的
  子串匹配，不是分词或语义匹配；短症状可能命中过多条目。
- **脱敏是启发式的**：字段名 + 令牌形态两条规则覆盖常见情况，但无法保证识别所有
  私钥文件内容或自定义密钥格式。
- **时间戳依赖注入的时钟**：模块不做时区换算，`createdAt` / `staleAt` 直接使用 `now()`
  返回的 ISO 字符串。

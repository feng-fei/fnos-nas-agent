# Phase 169 — 运行手册库（runbook-store）

## 1. 背景

Marvis 清单里的 K01–K10 指的是「知识与历史」。落到本仓库，知识部分一直只有
`docs/` 下的文档索引：它能列出仓库里有哪些设计文档，却不是一个 Agent 可以
**检索并复用**的运行手册库——没有条目、没有标签、没有稳定的检索结果，也
没有针对「知识条目里混进凭据」这一典型事故的防护。

对照表里排第四的缺口就是这个。Phase 169 补上一个最小但完整的运行手册库：

- 条目有严格寻址方式（唯一 id），写入即定址，不会出现「按标题找到两条」；
- 条目可以被 Agent 检索（标题、标签、正文），检索结果顺序稳定可复现；
- 条目正文**不得**携带凭据：疑似密钥在落库前被过滤，只保留被过滤的字段名；
- 库有大小上限、单条有长度上限、检索结果有数量上限；
- 给了数据目录就原子持久化，写失败绝不损坏已有数据。

本阶段不新增任何 HTTP 路由，也不改动 `server.mjs` / `README.md` /
`docs/README.md` / `pages.js`——接线与索引由统一的一方完成。

## 2. 导出 API

```js
import { createRunbookStore } from "./runbook-store.mjs";

const store = createRunbookStore({ dataDir, maxEntries = 500, now = () => new Date().toISOString(), fs });
```

`createRunbookStore(options)` 返回：

| 成员 | 签名 | 说明 |
| --- | --- | --- |
| `put` | `put(entry) => Promise<{written, entry?, redactedFields?} \| {written:false, reason, code}>` | 写入一条运行手册。**异步**（可能落盘），id 已存在时拒绝覆盖 |
| `get` | `get(id) => entry \| null` | 按 id 取一条。**同步** |
| `list` | `list({ tag?, limit?, offset? }) => {entries, total, limit, offset}` | 列表 + 标签过滤 + 分页。**同步** |
| `remove` | `remove(id) => Promise<{removed:true, id} \| {removed:false, reason, code}>` | 删除一条。**异步**（可能落盘） |
| `search` | `search(query, { limit? }) => {results, total, limit}` | 纯文本检索，返回带 `score` 与 `snippet` 的结果。**同步** |
| `stats` | `stats() => {count, tags, updatedAt, maxEntries, persisted}` | 条目数、标签清单、最近更新时间。**同步** |
| `load` | `load() => Promise<void>` | 显式载入持久化文件（未给 `dataDir` 时为空操作） |

另有一个纯函数导出，便于单独复用与测试：

```js
redactRunbookText(value) => { text, fields }
```

选项说明：

- `dataDir`：给了就把库持久化为 `<dataDir>/runbooks.json`；不给则是纯内存。
- `maxEntries`：库容量上限，默认 `500`。
- `now`：时钟注入，返回 ISO 字符串，测试中可固定。
- `fs`：文件系统调用注入（`open` / `mkdir` / `rename` / `chmod` / `unlink` /
  `readFile`），用于模拟写入失败。

写操作是异步的、读操作是同步的：`await store.put(...)` / `await
store.remove(...)` 必须 await；读接口即使被 `await` 也不影响正确性。

## 3. 条目格式

```js
{
  id: "disk-usage",              // 必填，/^[a-z0-9][a-z0-9._-]{0,63}$/
  title: "Disk usage check",     // 必填，非空，≤ 200 字符
  tags: ["storage", "ops"],      // 可选，≤ 16 个，每个 ≤ 40 字符，统一小写去重
  body: "……",                    // 必填，非空，≤ 64 KiB（65536 字符）
  source: "docs/phase-…md"       // 可选，≤ 512 字符
}
```

落盘后每条额外带有 `createdAt`、`updatedAt`（ISO 字符串）和
`redactedFields`（被过滤的字段名列表）。

上限常量（均从模块导出）：

| 常量 | 值 |
| --- | --- |
| `DEFAULT_MAX_ENTRIES` | 500 |
| `MAX_RUNBOOK_BODY_LENGTH` | 65536（64 KiB） |
| `MAX_RUNBOOK_TITLE_LENGTH` | 200 |
| `MAX_RUNBOOK_SOURCE_LENGTH` | 512 |
| `MAX_RUNBOOK_TAGS` | 16 |
| `MAX_RUNBOOK_TAG_LENGTH` | 40 |
| `DEFAULT_LIST_LIMIT` / `MAX_LIST_LIMIT` | 50 / 200 |
| `DEFAULT_SEARCH_LIMIT` / `MAX_SEARCH_LIMIT` | 20 / 100 |
| `MAX_SEARCH_TOKENS` / `MAX_SEARCH_TOKEN_LENGTH` | 16 / 64 |
| `MAX_SNIPPET_LENGTH` | 220 |

## 4. 校验与拒绝语义

所有拒绝都**不抛异常**，而是返回 `{ written:false, reason, code }`，
`reason` 是中文可读说明，`code` 是稳定的机器可读标识：

| code | 触发条件 |
| --- | --- |
| `invalid-entry` | 条目不是对象 |
| `invalid-id` | id 不匹配 `RUNBOOK_ID_PATTERN`（大小写、空格、开头字符、长度都受限） |
| `invalid-title` | 标题为空或超长 |
| `invalid-body` | 正文为空 |
| `body-too-large` | 正文超过 64 KiB |
| `invalid-tags` | 标签不是数组、过多或过长 |
| `invalid-source` | 来源超长 |
| `duplicate-entry` | id 已存在——**拒绝覆盖** |
| `max-entries-reached` | 库已达容量上限 |
| `persist-failed` | 落盘失败，已有数据未受影响 |

`remove` 对不存在的 id 返回 `{ removed:false, reason, code:"not-found" }`；
`get` 对不存在的 id 返回 `null`。

## 5. 检索语义

`search(query, { limit })`：

- 查询按空白切分为 token，**所有 token 都要命中**（AND 语义）；
- 命中范围是标题、标签与正文，计分：标题 3 分、标签 2 分、正文 1 分；
- 排序：分数降序 → `updatedAt` 降序 → id 升序，**同分同序，稳定可复现**；
- 结果条目带 `snippet`：正文中首个命中位置前后的片段（首尾以 `…` 标示），
  没有正文命中时回退到标题片段；
- 结果条数上限 `MAX_SEARCH_LIMIT`（100），`total` 报告命中总数而非截断数。

`list({ tag, limit, offset })`：`tag` 精确匹配（大小写不敏感），
`limit` 默认 50、上限 200，`offset` 从 0 开始；排序同样是
`updatedAt` 降序 + id 升序。

## 6. 脱敏规则

运行手册是人写的，最容易混进的就是凭据。写入前对**标题、正文、来源**做
过滤（`redactRunbookText`），命中后：

- 形如 `apiKey: sk-xxx`、`password = "xxx"`、`密码: xxx`、`token: xxx` 的
  **键值对**：值被替换为 `[已隐藏]`，并记录字段名（小写）；
- 没有字段名、但形如令牌的**裸值**（`sk-…`、`ghp_…`、`github_pat_…`、
  `AKIA…`、`AIza…`、`eyJ…` 的 JWT）：替换为 `[已隐藏令牌]`，字段名记为
  `body`；
- 字段名判定只看不敏感的名字形如：包含
  `key|token|secret|password|passwd|pwd|authorization|cookie|credential|private|bearer|sessionid|apikey|access_key|refresh_key`
  或中文 `密码|口令|密钥|令牌|凭证|授权`。

**只记录被过滤的字段名，绝不记录原文**：原始值在被替换的那一刻即丢弃，
既不进入落盘文件，也不进入返回值或任何日志。被过滤的字段名会出现在
`put()` 的 `redactedFields` 与条目的 `redactedFields` 中，便于界面提示
「已过滤字段：apikey」。

思路与仓库既有的 `structured-logger.mjs`（按字段名丢弃疑似密钥字段）和
`document-index.mjs`（`redact()` 隐藏键值对与令牌形值）一致；由于那两处
的规则未对外导出，本模块按同样的思路自带一份实现，未改动那两处代码。

## 7. 持久化语义

- 文件：`<dataDir>/runbooks.json`，结构为
  `{ version: 1, updatedAt, entries: [...] }`。
- **原子写**：先写同目录临时文件 `.runbooks-<uuid>.tmp`（`O_EXCL`，权限
  0600）→ `writeFile` → `fsync` → `close` → `rename` 覆盖目标 → `chmod 0600`；
  任一步失败都在 `finally` 中删除临时文件。**已有数据只在 rename 成功的那
  一刻才被替换**，中途失败时磁盘上的旧文件原封不动。
- 写入与删除通过仓库既有的 `createSerialWriteQueue()` 串行化，一次失败的
  写入不会毒化队列。
- 写失败（落盘异常）时：`put` / `remove` 返回 `persist-failed`，**内存状态
  一并回滚**，即「这次修改等于没有发生」。
- 载入：`load()` 读取文件；文件不存在视为空库；JSON 损坏或 `version` 不符
  时**忽略该文件**（不崩溃、不静默改写），库以空库启动。
- 目录权限 `0700`，文件权限 `0600`。
- 未给 `dataDir` 时全部在内存中，`stats().persisted` 为 `false`。

## 8. 测试结果

`node --test tests/phase-169-runbook-store.test.mjs` → **13 个用例全部通过**
（0 fail）。覆盖：

1. 写入与读取（`put` / `get` / `get` 未命中返回 `null`）
2. 非法 id 拒绝（空、大写、空格、超长、以 `-` 开头；合法 id 正则校验）
3. 空标题、空正文、超长正文（64 KiB + 1）被拒绝
4. 容量上限（`maxEntries: 2` 时第 3 条被拒）
5. id 已存在时拒绝覆盖，原条目不被改动
6. 标签过滤与分页
7. 检索命中标题 / 标签 / 正文，多 token 的 AND 语义，无命中返回空，同一
   查询两次顺序一致
8. 删除与删除未命中
9. `stats()` 的条目数、标签清单、最近更新时间、上限与持久化标记
10. 凭据字段被过滤且原文不落库（`sk-…`、`password="…"`、裸 `ghp_…` 令牌；
    另测无害文本原样保留）
11. 持久化往返（写入后重新建库能读回）
12. 写入失败（注入会抛错的 `rename`）时：返回 `persist-failed`、磁盘旧文件
    逐字节不变、临时文件已清理

## 9. 遗留限制

- **本阶段没有 HTTP 路由**。`server.mjs` 未改动，接线由统一的一方完成；
  在那之前这个库只能被进程内直接调用。
- **本阶段没有索引条目**。`docs/README.md` 与 `README.md` 按要求未改动，
  新文档需要在统一索引时补上。
- **检索是纯文本匹配**，没有分词、没有向量、没有同义词；中英文混排的
  查询依赖连续子串命中，跨词匹配能力弱于全文检索引擎。
- **AND 语义偏严**：多 token 查询要求全部命中，短查询更容易为空。
- **条目不可更新**：只能 `remove` 后重新 `put`，没有修订历史与版本号。
- **无并发多进程保护**：同一 `dataDir` 被两个进程同时写时，后者会覆盖
  前者（rename 是原子的，但没有做文件锁或版本冲突检测）。
- **脱敏是正则启发式**：不认识的凭据格式（例如自建服务的 token 形态）可能
  漏过；被过滤的字段名只提示、不阻断，条目仍会被写入。
- **`maxEntries` 只统计条目数**，不限制单库总体积；极端情况下 500 条
  64 KiB 正文约 32 MiB，文件本身受 `JSON.stringify` 结果大小影响，写入
  前未做整体字节上限校验（后续如需，可在 `persist()` 中补一个体积断言）。

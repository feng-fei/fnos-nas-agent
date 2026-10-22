# Phase 179 — 知识库面板、应用管理页（只读）与通知中心

## 背景

知识库（Phase 177）、诊断、巡检这些能力在 HTTP 层已经可用，但界面上看不到：运维人员仍然要逐条敲接口。本阶段补齐三块纯前端视图层，同时守住两条红线——**任何文本只走 `textContent`**，**任何没采集到的字段显示「未采集」而不是空白或「正常」**。

## 新增代码

| 文件 | 说明 |
| --- | --- |
| `apps/fnos-nas-agent/app/ui/knowledge-panel.js` | 19 个导出：知识库视图、来源与可信度、版本对比、页面变化、应用清单 |
| `apps/fnos-nas-agent/app/ui/notifications.js` | 15 个导出：事件归类、凭据清洗、汇总/过滤/已读、三类渲染 |
| `apps/fnos-nas-agent/app/ui/knowledge-panel.css` | 两块面板与通知中心的样式（含窄屏降级） |
| `tests/phase-179-knowledge-and-notifications.test.mjs` | 29 个用例 |

两个模块都是 ES module，零依赖、零 `fetch`、零 `innerHTML`；加载完成后分别挂到 `window.KnowledgePanel` 与 `window.Notifications`。

## knowledge-panel.js

### 来源与可信度（B02）

```js
classifySource(source)            // → { kind, label, isOfficial, weight, url, title, collectedAt }
orderSources(sources)             // 官方 → 厂商 → 运维 → 社区 → 长期记忆 → 未知，同权重稳定排序
evaluateCredibility(entry, opts)  // → { score, level: high|medium|low|unknown, reasons[] }
evaluateFreshness(entry, opts)    // → { state: fresh|stale|expired|unknown, ageMs }
```

- 来源权重是基础分，有采集时间 +5、有链接 +5，过期 −20、可能过期 −10；条目自带 `credibility` 时以显式分值为准，并在 `reasons` 里写明。
- 没有 `kind` 的来源归为 `unknown`，**不猜「官方」**——把社区页面伪装成官方文档比不显示更糟。

### 冲突与记忆边界（B03 / K09）

```js
detectConflicts(entries)          // 同标题不同正文 → { conflict, with[], label }；同标题同正文视为重复
describeMemoryBoundary(entry)     // 长期记忆必然附「不代表当前实时状态」
```

`detectConflicts` 只报告冲突，**不挑选哪一方正确**：返回值里没有 `resolution` 字段，选择权留给运维。

### 引用、版本与页面变化（B09 / B06 / B05）

```js
buildCitation(entry)              // 引用必须带来源名称、链接、采集时间；缺失时写「未知采集时间」
buildVersionView(versions, opts)  // 按语义化版本降序，标记 isLatest / isCurrent
compareVersions(from, to)         // → { changed, summary }
compareEvidenceSnapshots(prev, cur) // → { changed, previousHash, currentHash, summary }
```

- `isLatest` 取**实际最高版本**而非输入顺序第一项（本阶段修复的真实缺陷：原先按数组下标判定，版本列表乱序时会把旧版本标成最新）。
- `compareEvidenceSnapshots` 只比较已经拿到的证据，不抓取、不联网；哈希用 FNV-1a 32 位，避免依赖 WebCrypto。

### 应用管理页（UI06）

```js
describeCollectionState(value)    // null/""/[] → { collected: false, label: "未采集" }
buildAppInventoryView(snapshot)   // → { sections[], groups[], summary{collectedSections, missingSections, ...} }
```

输入既可以是 `/api/system/snapshot` 的 `sections`，也可以直接是 `{ containers, images, deployments }`。每个分组、每个字段都带 `collected` 布尔值；`summary.missingSections` 统计缺数据的分区数。

## notifications.js

```js
classifyNotification(raw)         // exception | approval | task | ""（无法归类的直接丢弃）
normalizeNotification(raw)        // → { id, type, title, detail, level, tone, read, redacted }
collectNotifications(sources)     // 三路合并、按时间倒序、按 id 去重
summarizeNotifications(items)     // → { total, unread, read, byType, unreadByType }
filterNotifications(items, f)     // { type, unreadOnly }
markNotificationsRead(items, ids) // 空 ids = 全部已读；返回新数组
toggleNotificationRead(items, id)
clearReadNotifications(items)
```

- **凭据不出库**：`scrubNotificationText` 覆盖 `sk-`、`ghp_`、`github_pat_`、`AKIA`、`ASIA`、`AIza`、`ya29.`、`xox[baprs]-`、JWT、`Bearer`、`password/token/secret/api_key = ...` 等形态，命中即替换为 `[已隐藏]` 并置 `redacted: true`；`stripCredentialFields` 递归丢弃 `apiKey` / `password` / `authorization` / `cookie` / `token` / `privateKey` / `session` 等字段。
- **渲染只走 `textContent`**：两个模块的源码里没有 `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write`，测试剥离注释后断言。
- 标记已读、切换、清空都返回新数组，入参不被修改（测试用 `JSON.stringify` 前后比对）。

## 接线方式（已落地）

```html
<link rel="stylesheet" href="/ui/knowledge-panel.css">
<script type="module" src="/ui/knowledge-panel.js"></script>
<script type="module" src="/ui/notifications.js"></script>
```

两个 ES module 把纯函数与渲染函数挂到 `window.KnowledgePanel` / `window.Notifications`，并在挂载后分别派发 `knowledge-panel-ready` / `notifications-ready` 事件。`pages.js`（传统 script）因此不需要 import，靠事件接管首屏渲染。

数据来源都是既有的只读接口，视图层不认识接口形状，只认识视图模型：

| 区块 | 模型函数 | 接口 |
| --- | --- | --- |
| 知识库 | `buildKnowledgeView` / `renderKnowledgePanel` | `GET /api/knowledge?q=&source=` |
| 应用与容器 | `buildAppInventoryView` / `renderAppInventory` | `GET /api/system/snapshot` |
| 通知中心 | `collectNotifications` / `summarizeNotifications` / `renderNotificationCenter` | `GET /api/audit?outcome=error&limit=20`、`GET /api/actions/pending`、`GET /api/tasks?limit=20` |

页面层接线要点（`apps/fnos-nas-agent/app/ui/pages.js`）：

- `refreshKnowledgePage()` 由 `#knowledge-card` 路由触发，`#refresh` 与页面内「刷新」共用；
- 三路通知来源用 `Promise.allSettled` 读取，单个接口失败只在状态行注明，不让整块空白；
- 所有文本交给渲染函数用 `textContent` 写入，`pages.js` 的知识区块不拼 HTML，也不发写请求；
- 「全部标为已读」「清除已读」只改内存中的视图状态，刷新后按服务端事实重新汇总，不写服务端。

## 验证

```
node --test tests/phase-179-knowledge-and-notifications.test.mjs   # 33 tests / 33 pass
```

其中 4 例是页面层接线校验：路由分支与控件绑定、知识区块不含 raw HTML/`eval`、三路来源失败被隔离、`index.html` 的容器与 `<script type="module">` 齐备。

## 遗留

- 通知的「已读」状态不持久化：本次只在会话内存中生效，刷新后回到服务端事实。若要跨刷新保留，需要先定义一条只存 `{id,readAt}` 的服务端记录，并单独评估其容量与清理策略。
- 通知中心不主动轮询：进入页面或点「刷新」才汇总，避免在低配 NAS 上制造常驻请求。
- 清单对应项：B02 / B03 / B05 / B06 / B09 / K03 / K08 / K09 / K10 / UI06。
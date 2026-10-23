# Phase 214：知识条目的核验、标记过期与归档

## 背景

Phase 213 把「写一条知识」做成了两步（预览 → 提交）。但条目写进去之后仍然只能躺在那儿：`knowledge-base` 支持 `preview("verify")` 与 `preview("archive")`，界面却没有任何入口。结果是——知识库能"收集"，不能"维护"：一条现场观察后来被证伪，只能在文件里手改 JSON。

这一阶段把三个维护动作摆到条目上：**核验**、**标记过期**、**归档**。

## 交互

每条知识后面有三个按钮：

| 按钮 | 服务端动作 | 效果 |
| --- | --- | --- |
| 核验 | `preview("verify", { id, verification: "verified" })` | 状态改为 `verified`，可信度按来源重算，`speculative=false` |
| 标记过期 | `preview("verify", { id, verification: "stale" })` | 状态改为 `stale`，可信度降为 `speculative` |
| 归档 | `preview("archive", { id })` | 打上 `archived`，默认列表不再返回 |

点任意一个按钮，先在原地展开一条确认条，写明「会改什么、后果是什么」：

- 核验：「将把「标题」标记为已核验：核验状态会改为 verified，立即生效。」
- 归档：「将把「标题」归档：归档后不再出现在检索结果里，也不能从界面上恢复。」

确认后才提交；取消会把预览丢弃（新加的 `POST /api/knowledge/cancel`），不在服务端留下悬空预览。

## 为什么按钮在面板里、请求在模块里

`knowledge-panel.js` 是纯渲染（行内已写明「本文件不含 innerHTML，也不发请求」），`knowledge-write.js` 负责所有写请求和两步流程。条目级动作沿用这条边界：面板只输出 `data-knowledge-action` / `data-knowledge-id` 两个属性，`knowledge-write.js` 用事件委托接管点击。这样：

- `pages.js` 快照式的知识库区块仍然没有写请求，既有守卫不用改；
- 所有写路径集中在一个模块里，只有 `preview`、`commit`、`cancel` 三个出口。

## 安全边界

- **状态值只来自服务端枚举**：`verified` / `stale` 是 `KNOWLEDGE_VERIFICATION_STATES` 里的值，界面不发明新状态。
- **归档不可逆**：确认文案直说「不能从界面上恢复」；服务端也没有反归档接口，界面不给假按钮。
- **两步不能合并**：提交只发 `previewId`，条目内容以预览时的快照为准，避免"看了 A、改了 B"。
- **取消即释放**：`cancel` 只丢弃预览，不做任何写入（测试断言该分支里不出现 `commit`）。
- **登录 + 同源 + JSON**：三个写路由都要求有效会话、同源、`application/json`。
- **渲染只用 textContent**：标题与文案都来自外部输入。

## 测试

新增 `tests/phase-214-knowledge-entry-actions.test.mjs`，9 例全通过：

1–2. 三个动作生成的 `{operation, input}` 与服务端契约一致；归档不带核验状态且标记为不可逆。
3. 未知动作、空 id 一律拒绝。
4. 确认文案包含条目标题、`verified`、「立即生效」；归档文案包含「不能从界面上恢复」。
5. 取消后提交返回 `knowledge-preview-not-found`（服务端确实丢弃了预览）。
6. 面板为带 id 的条目渲染三个动作、归档条目只显示说明、不拼 HTML。
7. 写入模块只有 `preview` / `commit` / `cancel` 三个出口，并带 `确认执行` 按钮。
8. 服务端提供取消路由、401/403/400 分支齐全、审计名为 `knowledge.cancel`、取消分支不含 `commit`。
9. 样式里给动作与确认条留了位置。

## 遗留

- 归档条目目前在界面上不可见（列表默认过滤），也没有「查看已归档」开关；服务端已支持 `?archived=1`，接一个开关即可。
- 冲突（`conflicted`）目前靠 `detectKnowledgeConflicts` 展示，还没有「采纳其中一条作为结论」的合并流程。

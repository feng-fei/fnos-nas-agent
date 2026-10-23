# Phase 216：知识库的「显示已归档」开关与归档视图

## 背景

Phase 214 给知识条目补了「核验 / 标记过期 / 归档」三个维护动作，服务端 `GET /api/knowledge/list` 也一直支持
`archived=1` 把归档条目一起列出来。但列表页没有这个开关，用户归档一条知识之后，条目当场从列表里消失，
既看不到归档结果，也没有任何入口把它找回来——归档变成了一次不可撤销的「视觉删除」。

这一阶段只补这条落差，并顺手修掉一个会误导用户的真缺陷。

## 缺陷：归档标记在视图模型里被丢掉

`apps/fnos-nas-agent/app/ui/knowledge-panel.js` 的渲染层早就写了归档分支：

```js
if (record.archived) {
  entry.append(createElement(doc, "p", "knowledge-panel__item-note", "已归档，不再参与检索。"));
} else {
  // 三个维护动作按钮
}
```

但 `normalizeEntry()` 归一化条目时只取了 `id/title/excerpt/tags/source/updatedAt/ttlMs/credibility/kind/memory/realtime`，
`buildKnowledgeView()` 的返回对象也没有 `archived` 字段。于是 `record.archived` 永远是 `undefined`，
一旦归档条目出现在列表里，页面会给它画出一整排**不该存在的维护按钮**——点了会被服务端按「条目不可用」拒绝，
但用户看到的是「按钮在、但按不动」。

修法很小：`normalizeEntry()` 与 `buildKnowledgeView()` 的结果都把 `archived` 一路带下去。

## 改动

| 文件 | 改动 |
| --- | --- |
| `apps/fnos-nas-agent/app/ui/index.html` | 知识库页「刷新」旁边新增 `<label class="muted knowledge-archived-toggle"><input id="knowledge-show-archived" type="checkbox"> 显示已归档</label>` |
| `apps/fnos-nas-agent/app/ui/pages.js` | `knowledgePageState` 增加 `archived:false`；`refreshKnowledgePanel()` 在开关打开时给列表请求带上 `archived=1`；状态行在包含归档时标注「（含已归档）」；绑定复选框的 `change` 事件（只重拉列表，不重拉应用清单） |
| `apps/fnos-nas-agent/app/ui/knowledge-panel.js` | `normalizeEntry()` 与 `buildKnowledgeView()` 的结果对象补 `archived`，让渲染层的归档分支真正生效 |
| `apps/fnos-nas-agent/app/ui/knowledge-panel.css` | `.knowledge-archived-toggle` 一行样式，让复选框与按钮同排对齐 |
| `apps/fnos-nas-agent/tests/phase-216-knowledge-archived-view.test.mjs` | 4 例：视图保留 `archived` 标记、归档分支只给说明不给动作、页面把开关接到 `archived=1`、服务端仍只按显式参数包含归档 |

## 安全与语义边界

- 开关只改查询参数，不改变服务端默认行为：不带 `archived=1` 时归档条目依然不参与列表与检索。
- 归档条目在界面上是只读的：只显示「已归档，不再参与检索。」，不提供核验/标记过期/归档按钮。
  取消归档动作当前不在 MVP 范围内（服务端也未提供），因此这里不做假入口。
- 前端每处渲染都用 `textContent` / `createElement`，不拼 HTML 字符串。

## 验证

- `node --test tests/phase-216-knowledge-archived-view.test.mjs` → 4/4 通过。
- `node --check apps/fnos-nas-agent/app/ui/pages.js`、`node --check apps/fnos-nas-agent/app/ui/knowledge-panel.js` 通过。
- 相关既有用例回归：`tests/phase-214-knowledge-entry-actions.test.mjs`、`tests/phase-179-knowledge-and-notification-center.test.mjs` 全通过。
- 全量 `node --test` 与失败集合逐条对比后见提交说明；release gate 通过。

## 遗留

- 「取消归档」需要服务端新增动作与审批，暂不做。
- 知识列表的分页仍是「一次拉一页、上限 20」，归档开关只在当前筛选条件内生效。

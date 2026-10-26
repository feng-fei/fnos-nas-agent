# Phase 224 — UI2 成为默认控制台（UI-6 第一刀）

## 变更

- `GET /` 现在返回 `ui/next/index.html`（新壳含 `<base href="/next/">`，
  相对资源在根路径下仍解析到 /next/*）；
- `GET /legacy` 保留旧 UI 入口（旧资产仍在 /ui/*），冻结不再投入；
- `GET /next` 维持别名。

## 为什么旧 UI 不在本阶段删除

约 15 个既有测试（phase-13/29/44/60/61/65-67/77-84/91/93/135/149/151/156/157/166/174/179/186 等）
直接读取 `app/ui/index.html`、`ui/pages.js`、`ui/core.js` 等旧文件做源码断言。
这些断言在旧文件不动的前提下继续通过（本 PR 已本地回归 docs-links、phase-157、phase-211，
36/36 通过）。旧 UI 删除必须与这批测试的退役/重写同批进行，作为独立的清理阶段执行，
避免「一次提交删一半」的中间态。

## 后续（UI-6 收尾，独立 PR）

1. 为 UI2 建立与旧断言等价的源码/集成测试（路由对账、渲染安全、会话状态机、SSE 消费）；
2. 同批删除 `ui/index.html`、`ui/pages.js`、`ui/core.js`、`ui/styles.css`、
   `knowledge-panel/model-settings/notifications` 与对应旧测试；
3. FPK 包体与 manifest 复核（app/ui/next 已随包分发）。

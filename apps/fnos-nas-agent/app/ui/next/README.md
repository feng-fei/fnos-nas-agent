# UI2（下一代操作界面）

从零重建的操作 UI，**目标是完全替换** `../`（旧 UI）。目录：`app/ui/next/`。

## 结构

- `index.html` —— 静态外壳：头部 / 桌面 rail / 移动 tabbar / 认证浮层
- `styles.css` —— 设计令牌 + BEM 组件（继承旧 styles.css 令牌，无 legacy 层）
- `js/h.js` —— DOM 助手（字符串一律 textContent，禁 HTML 注入）
- `js/format.js` —— 展示格式化
- `js/store.js` —— signal 状态（`store.session / route / refreshTick`）+ `effect()`
- `js/api.js` —— **唯一 API 出入口**：`ROUTES` 命名映射全部服务端路由；`call(name,{params,query,body})`
- `js/ui.js` —— toast / modal / confirm
- `js/router.js` —— hash 路由 `#/zone[/sub]`，五区：总览 / 对话 / 文件 / 系统 / 设置
- `js/main.js` —— 引导、会话状态机（loading→setup|login→ready）、顶栏动作
- `js/pages/*.js` —— 每区一个模块，`render(root, ctx)` 契约

## 约定

1. 页面代码禁止手写 `/api/...` 字符串——一律 `call("routeName")`（测试对账锁死）；
2. 禁止 `innerHTML / insertAdjacentHTML / outerHTML / document.write`；
3. 明文 apiKey 只允许出现在「读取输入框、校验、请求体、清除标记」四类位置，不得进入渲染；
4. 每页一个 ES Module；共享状态只放 `store.js`；
5. 页面加载订阅 `store.refreshTick` 实现顶栏刷新，`ctx.stop()` 注册清理（防订阅泄漏）。

## 路线

- UI-1（本目录现状）：外壳 + 路由 + store + API 客户端 + 认证 + 五区骨架
- UI-2 对话页（任务/直连、SSE、工具卡、审批）
- UI-3 文件页（交互定稿：多选批量 / 复制剪切粘贴 / 上传 / 预览）
- UI-4 系统区七个子页迁移
- UI-5 设置区四组迁移 + 服务端错误码化
- UI-6 目录级替换旧 UI（`ui/` ← `ui/next/`），删除 legacy，测试全面切换

## 静态预览

`node --test` 不覆盖视觉；本地看效果可直接起服务后访问 `/next/`（待 server 接线），
或用工作区的单文件预览版（由模块文件自动拼装，`window.__UI_PREVIEW__=1` 启用演示数据）。

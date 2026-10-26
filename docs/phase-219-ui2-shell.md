# Phase 219 — UI2 外壳骨架（UI-1）

> 决策背景：操作者确认**放弃旧 UI**（"旧 UI 感觉就没法使用"），不再做长期新旧共存。
> 本阶段从零搭建下一代操作界面的基础框架，目标是最终**目录级替换** `app/ui/`。

## 交付内容（`apps/fnos-nas-agent/app/ui/next/`）

### 架构

| 文件 | 职责 |
| --- | --- |
| `index.html` | 静态外壳：头部 / 桌面 nav-rail / 移动 tabbar / 认证浮层 |
| `styles.css` | 设计令牌 + BEM 组件。继承旧令牌体系，删除全部 legacy 兼容层 |
| `js/h.js` | DOM 助手；字符串子节点一律 `textContent`（延续禁 HTML 注入不变量） |
| `js/format.js` | 展示格式化（字节/时长/时间/按字段名自动识别） |
| `js/store.js` | 约 45 行 signal 状态：`store.session / route / health / refreshTick` + `effect()`（订阅自动回收） |
| `js/api.js` | **唯一 API 出入口**：`ROUTES` 命名映射服务端全部静态与动态路由（约 95 条）；`call(name,{params,query,body})` 统一返回 `{ok,status,data}` |
| `js/ui.js` | toast / modal / confirm（Esc、遮罩关闭、焦点管理） |
| `js/router.js` | hash 路由 `#/zone[/sub]`；五区：总览 / 对话 / 文件 / 系统 / 设置 |
| `js/main.js` | 引导与会话状态机 `loading → setup|login → ready`；顶栏动作；`R` 键刷新 |
| `js/pages/*.js` | 每区一个模块，`render(root, ctx)` 契约；`ctx.stop()` 注册清理 |

### 服务端接线

- `GET /next` 返回 `ui/next/index.html`；
- `GET /next/*` 由 `serveNextAsset()` 提供静态资源：扩展名白名单复用 `UI_ASSET_TYPES`，
  解析结果用 `relative()` 严格限定在 `ui/next` 内，拒绝 `..`、反斜杠与越界路径。

### 信息架构（五区）

旧 UI 十个平铺页面收敛为五区：

1. **总览** — 健康卡组（状态/执行模式/任务/模型）、存储条、系统信息（已接通 `/api/overview`、`/api/diagnostics`）；
2. **对话** — 产品核心升为一等公民：任务/直连双模式、消息流、输入区（SSE 与工具卡在 UI-2 接通）；
3. **文件** — 浏览骨架 + 交互定稿说明（多选批量/复制剪切粘贴/上传/预览，按工作区原型实施）；
4. **系统** — 七个子页签：概览、网络与证书、容器与服务、存储健康、自动化、审计与轨迹、诊断报告；
5. **设置** — 模型服务 / Skill 管理 / 知识库 / 安全边界四组。

### 会话与安全

- 登录前仅可访问 `/api/health`、`/api/session`、`/api/setup`、`/api/login`，与旧 UI 一致；
- setup 表单含密码强度（10–128）、二次确认与安装码（`setupCodeRequired` 时显示）；
- 明文 apiKey 在 UI2 代码路径中只允许出现在「读取输入框、校验、请求体、清除标记」四类位置，不得进入渲染路径；
- 渲染层零 `innerHTML`（含 modal），页面代码禁止手写 `/api/...` 字符串（`ROUTES` 之外无法发起请求）。

## 设计取舍

- **不引入任何第三方前端运行时**（未选 vendor Preact 方案）：`h()` + signal 的组合在
  文件管理器交互原型（工作区 `file-manager-ui.html`）中已验证可承载同等交互密度；
  保留"仓库零依赖、无构建、可离线审计"的属性。
- **不做新旧 UI 共存路由**：旧 UI 冻结不再投入，UI2 每阶段以真实接口交付，最终一次性替换。
- 旧 UI 的 phase-157/211 源码断言测试不受影响（旧文件未改动），UI-6 时随 legacy 一并退役。

## 验证

- 全部模块通过 `node --check`；`server.mjs` 语法通过；
- 本机实跑（Windows + Node 22，`AGENT_DATA_DIR` 绝对路径）：服务启动成功，
  `GET /next` 200（text/html），`/next/js/main.js`、`/next/js/pages/home.js` 200（text/javascript），
  `GET /next/../server.mjs` 被 404 拒绝，`GET /api/health` 正常；
- 静态预览：工作区 `gen-preview.py` 将模块拼装为单文件（`window.__UI_PREVIEW__=1` 时
  `api.js` 内置演示数据），无需服务端即可审查交互。

## 边界与遗留

- 本阶段不迁移任何旧页面功能；对话/文件/系统/设置各区仅有骨架与已接通的只读链路；
- 尚无 UI2 专属测试（UI-2 起随页面补源码断言：路由对账、渲染安全、会话状态机）；
- 旧 UI 仍为默认入口（`/`），切换默认入口在 UI-6 一次性完成。

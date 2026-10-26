# Phase 225 — UI2 覆盖审计、不变量测试与退役清单

## 一、覆盖审计（phase-211 方法论，脚本化）

对 `server.mjs` 全部 API 路由与 `ui/next` 的 `ROUTES` 做双向对账：

- server 静态路由 **78 条**全部有 UI2 对应模板（[A] 缺口为 0）；
- `ROUTES` **101 条**，其中 81 条被页面真实调用，20 条为上轮未接的漏项，本阶段已修复：
  - 系统区补：工具清单（toolsList）、备份前检查（backupPrecheck，修正为 GET）、
    技能组合计划（compositionsPlan）、网页取证（webFetch，默认关闭照实呈现）；
  - 系统区列表详情：诊断历史/运行手册/工作流/设备档案点击拉取 `*:id` 详情；
  - 对话页补：直连通道状态（chatStatus）、CLI 首次授权命令生成器（trimCliLoginCommand，
    host/port/scheme/flow/self-signed，只生成命令不收集验证码）、清理任务历史（tasksClearHistory）；
  - Skill：官方 CLI 安装按钮（skillInstallCli，仅 fnos 且 approved/enabled）、
    远程导入支持多行 URL 批量（skillImportRemoteBatch）；
  - 知识库：表单变更即作废预览（knowledgeCancel）；文件页：重复文件扫描（fileDuplicates）、
    批量移动改走 operations/batch（服务端原子校验，失败回退逐项）。
- 审计确认有意不由 UI 调用的路由：`tools/:id/run`（phase-211 口径：放开会削弱
  「destructive 必须单独确认」约束）与 `skills` 的 register 语义（导入流程已覆盖）。
- 渲染安全反向扫描：UI2 全部文件零 `innerHTML/insertAdjacentHTML/outerHTML/document.write`，
  零手写 `/api/...` 字符串（[D] 为空）。

## 二、UI2 不变量测试（`tests/ui2-console.test.mjs`，9 例全过）

这是旧 UI 源码断言在重建前端的等价物，也是退役旧 UI 的前置条件：

1. 渲染零 HTML 字符串拼接（全文件扫描四种注入面）；
2. 页面只能经命名 API 客户端访问服务端；
3. ROUTES 模板 ↔ server 双向对账（静态前缀 + 动态尾段）；
4. 明文 apiKey 只允许出现在 settings 表单/请求载荷（出现次数上限 8）；
5. 外壳会话状态机与五区路由装配；
6. 对话页必须消费任务事件流且保留轮询兜底、审批闭环；
7. 文件页破坏性操作必须走服务端 202 审批；
8. 设置区危险模式切换必须本地确认；知识库两步写入必须经 previewId。

## 三、旧 UI 退役清单（下一批 PR，本阶段不执行）

删除 `app/ui/`（index.html、pages.js、core.js、styles.css、knowledge-panel.*、
knowledge-write.js、model-settings.*、notifications.js）需要同批处理：

1. **`scripts/check-release-gates.mjs`：41 条**针对旧 UI bundle 的历史断言
   （`readUiBundle()` 读旧 index.html + ui/*.js），需逐条迁移到 UI2 等价断言；
   另有工作流断言 `find $app/app/ui`、`test -s core.js/styles.css`（FPK 暂存校验）；
2. **14 个测试文件**的旧 UI 耦合：phase-154/157/179/213/214/216 整文件退役
   （纯旧 UI 模块/页面断言）；phase-141/156/166/186/187/191/217/211/212/215
   摘除旧 UI 断言块、保留服务端用例；
3. **phase-135**：移除 `/legacy` 与 `/ui/*` 资产断言（本阶段已更新为 UI2 契约 + /legacy 覆盖）；
4. server：删除 `/legacy` 路由与 `serveUiAsset`（保留 `UI_ASSET_TYPES` 供 serveNextAsset）；
5. favicon 迁移：`ui/favicon.svg` → `ui/next/favicon.svg`（`<base>` 下引用 `favicon.svg`）。

不做一刀切的原因：gates 的 41 条断言每条都是历史 phase 的安全契约，逐条迁移需要
逐一在 UI2 上找到等价实现点；盲删会让发布门禁失去对前端的全部约束力。

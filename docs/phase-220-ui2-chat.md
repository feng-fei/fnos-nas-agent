# Phase 220 — UI2 对话页（UI-2）

> 承接 Phase 219 的外壳骨架，交付五区中的产品核心：对话页。契约对照旧 `pages.js`
> 与 `server.mjs` 逐条核对后重写，不迁移旧代码。

## 交付（`ui/next/js/pages/chat.js`，约 360 行）

### 任务模式（工具执行）
- `POST /api/agent/message {text, history}` → 202 `{task}`；
- `EventSource GET /api/tasks/:id/events` 消费事件流：`progress`（进度条/阶段）、
  `tool`（工具卡）、`approval`（触发审批刷新）、`done`/`error`（终止流）；
- 同时以 800ms 轮询 `GET /api/tasks/:id` 兜底（EventSource 不可用时也不丢结果）；
- 终态渲染：`result.message` + 最多 10 张工具卡（`formatDisplayValue` 人类可读化，
  超长截断）；失败/取消/仍在执行分别有明确文案；
- 停止：`POST /api/tasks/:id/cancel`，区分「已请求停止（当前工具先完成）」与「已取消」。

### 直连模式（模型直答）
- `POST /api/chat/message {messages}` → SSE：`delta` 增量渲染、`done` 终文、`error` 报错；
- fetch + ReadableStream 手工解析帧（EventSource 无法 POST），AbortController 可中止；
- 模式选择持久化在 `localStorage`（沿用旧 UI 的 `ui2.chat.mode` 新键）。

### 审批闭环
- `GET /api/actions/pending` 渲染审批卡：标题/描述/目标/参数 JSON/截止时间；
- 审批卡按 `action.taskId` **内联到对话对应回合**，无回合时落在「待确认」卡片；
- 确认前先本地二次确认（`confirmModal`），再 `POST /api/actions/:id/confirm|deny`；
- 60 秒一次性语义完全由服务端裁决，前端不缓存、不复用。

### 任务队列
- `GET /api/tasks/status` 队列摘要 + `GET /api/tasks?limit=6&offset=` 分页列表；
- 活动任务可取消；完成后任务结果摘要入列。

### 会话上下文
- 页面内存 `history`（user/assistant，≤8 条由服务端 `normalizeConversationHistory` 再裁剪）；
- 任务完成把 `result.message` 写回上下文；「清空上下文」只清内存，不入库。

## 安全不变量

- 全部渲染 `textContent`（工具卡 JSON 走 `JSON.stringify`，不拼 HTML）；
- apiKey/凭证不出现在任何渲染路径；审批参数展示来自服务端 `args`，只读；
- 对话上下文不入任务历史（延续旧 UI 隐私边界）。

## 验证

- `node --check` 通过；本机实跑：setup→login 会话建立后
  `GET /api/agent/status`、`/api/chat/status`、`/api/tasks/status` 均返回预期结构；
- 静态预览（`__UI_PREVIEW__`）内置任务执行模拟（进度→工具卡→完成），
  直连模式与服务端接口在预览环境不可用属预期。

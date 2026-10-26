# Phase 221 — UI2 文件页（UI-3）

> 交互定稿来自工作区原型 `file-manager-ui.html`（多选批量/复制剪切粘贴/上传/预览），
> 本阶段按真实契约整体接入 `ui/next/js/pages/files.js`（约 560 行）。

## 真实契约（对照 `server.mjs` / `file-browser.mjs` / `file-manager.mjs`）

- `GET /api/files?path&limit&offset&sort&q&type` →
  `{roots[], path, parentPath, entries[{name,path,type,sizeBytes,modifiedAt}], offset, totalEntries, totalDirectoryEntries}`；
  排序/搜索/类型过滤全部服务端完成（directories-first | name-asc/desc | size-desc | modified-desc）；
- `POST /api/files/operation`：`mkdir {path,name}` / `rename {path,name}` / `move {path,destination}` /
  `delete {path}`（delete 永远 202 → `{approvalRequired, approval}` → `/api/actions/:id/confirm|deny`）；
- `POST /api/files/upload?path=&name=`：`application/octet-stream` 原始字节，XHR 进度条；
- `GET /api/files/preview?path=` → `{name, path, sizeBytes, content}`（二进制 415 由 UI 呈现）；
- `GET /api/files/checksum|download`；`POST /api/files/rename-plan|rename-apply {confirm:true}`。

## 功能清单

- 卷切换（roots chips）、面包屑（roots 最长匹配推导）、上级、分页（60/页）；
- 列表/网格双视图（记忆偏好）、服务端搜索/类型过滤/排序；
- 多选（单行复选框 + 全选）→ 底部批量栏：剪切/移动/批量改名/删除；
- **批量改名**：四种服务端模式（serial/add/replace/normalize），先 `rename-plan`
  预览（含冲突/错误统计），确认后 `rename-apply {confirm:true}` 一次性应用；
- **移动**：目录选择器实时浏览（`type=directory`），拦截「移入自身子目录/原地移动」；
- **删除**：逐项进入服务端一次性审批，审批弹窗展示目标与参数，拒绝/确认；
- **上传**：多选 + 整目录拖拽，XHR 进度面板，完成即刷新；
- **预览抽屉**：元信息 + 文本内容（20KB 截断）+ 下载 + 校验和；
- **剪贴板**：剪切/粘贴（跨目录 move）+ Ctrl+C/X/V；
  **「复制」在真实模式禁用**——服务端只有 mkdir/rename/move/delete 语义，无 copy；
  按钮带提示并登记为后续服务端阶段；演示模式（预览）支持完整复制体验。

## 安全不变量

- 全部 `textContent` 渲染；预览内容与审批参数不进 HTML；
- delete 只走服务端 202 审批，前端布尔值不是授权；upload 受服务端执行策略闸门；
- 无手写 `/api/...` 字符串（一律 `call()/routeUrl()`）。

## 验证

- `node --check` 通过；本机实跑（Windows）：`GET /api/files` 未配置 `AGENT_FILE_ROOTS`
  时返回 `{roots:[], path:null, note:"…AGENT_FILE_ROOTS…"}`，UI 呈现空态与提示，不崩溃；
- 静态预览内置可操作文件树（mkdir/rename/move/delete/copy/改名计划），全流程可交互。

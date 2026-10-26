# Phase 223 — UI2 设置区（UI-5）

四组设置全部接真实契约（`ui/next/js/pages/settings.js`，约 480 行）。

## 模型服务
- 列表：名称/模型/接口/默认/启用/密钥徽章 + 最近测试结果；
- CRUD：添加/编辑弹窗（endpoint 支持 base 自动补全，Phase 218 语义）；apiKey 创建必填、
  编辑留空保留、显式清除（清除即停用）；UI 永远读不回明文；
- 动作：连接测试（弹窗展示服务端结论，不含响应正文）、设为默认、删除（确认）；
- 用量统计（modelsUsage）与预设快填（modelsPresets）。

## Skill 管理
- 列表：状态徽章（pending_review/approved/enabled/disabled/rejected）+ 清单审查徽章 +
  归档摘要；状态机按钮按 `skills.mjs` TRANSITIONS 生成（服务端仍是唯一裁决者），
  流转带备注输入；
- 导入：ZIP 多选上传（application/zip + x-skill-name/version/source 头，≤25MiB 校验，
  XHR 进度），全部进入隔离待审核；远程导入（name/version/url）；
- 删除走确认弹窗；批量流转沿用服务端 batch 路由口径（本阶段先做单项 + 后续按需加批量栏）。

## 知识库
- 统计（knowledgeStats）与冲突（knowledgeConflicts，并列展示不做自动取舍）；
- 条目列表（来源/置信度/归档徽章）；
- 两步写入：表单（标题/主题/来源枚举/claims JSON）→ `knowledge/preview`（服务端校验，
  拒绝时逐条理由）→ 凭 previewId `knowledge/commit`；改表单即作废预览。

## 安全边界
- 执行模式：GET 展示当前/来源，分段控件切换（POST /api/execution-mode），切换前
  本地确认并按目标模式给出后果提示（停机 = 全部拒绝、仅控制台可恢复）；
- 安检（security/inspection）一键运行 + 结果 pre；设备能力位图（system/capabilities）；
- 固定「边界声明」卡：任意命令执行与导入 Skill 代码执行永久关闭等。

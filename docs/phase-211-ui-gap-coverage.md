# Phase 211：把「只在服务端存在」的能力真正摆到界面上

## 背景

用户提出两个要求：先审查「是不是有些功能写了但前端没写、没显示出来」，然后继续开发。

审查用脚本对比的方式做的：从 `apps/fnos-nas-agent/app/server.mjs` 抽出全部 `url.pathname === "/api/..."` 静态路由，再检查 `app/ui/*.js` 与 `index.html` 里是否出现对应字面量。第一版脚本按模板前缀匹配，把大量拼接路径误判为未覆盖；最终口径是「路由字面量 + 允许前缀拼接」，得到可信结果。

## 审查结论

服务端共 81 条静态路由，审查前有 19 条在界面上没有任何入口。逐条核对后分成两类：

| 类别 | 路由 | 处理 |
| --- | --- | --- |
| 应当有入口 | `/api/network/diagnostics`、`/api/network/policy`、`/api/network/check`、`/api/deploy/precheck`、`/api/compositions/validate`、`/api/diagnostics/report`、`/api/diagnoses`、`/api/write-actions`、`/api/docker/stats`、`/api/network/interfaces`、`/api/diagnostics/log-evidence`、`/api/compositions`、`/api/workflows/triggers/evaluate`、`/api/mcp/status`、`/api/runbooks`、`/api/runbooks/stats`、`/api/workflows`、`/api/system/device-profiles`、`/api/health-checks`、`/api/agent/trace`、`/api/security/inspection`、`/api/web/fetch`、`/api/knowledge/stats`、`/api/knowledge/conflicts` | 本轮接上界面入口 |
| 有意只给智能体 | `/api/tools/:id/run`、`/api/files/operations/batch`、`/api/knowledge/preview`、`/api/knowledge/commit` | 保持 API-only，并在测试里锁死 |

理由：后四条要么是「模型调用工具」的出口，要么是危险写操作的两步中间态（预览 → 提交）与批量破坏性动作。界面上给它们开入口，等于绕过既有的单步审批与二次确认设计。

## 新增界面：诊断与运维

新增一个整页 `#ops-card`（工作台导航「诊断与运维」），把上述只读能力集中到一个页面，避免把十几个零散按钮塞进概览页。

- **网络体检**：策略开关、出口白名单、DNS/网关/代理、连通性巡检、接口地址。
- **部署校验**：提交部署计划 JSON → 许可判定、服务清单、风险与建议。
- **技能组合校验**：组合计划 JSON → 七类问题、拓扑顺序、权限抬升说明。
- **诊断报告**：一键生成报告并带证据条目；下方是历史列表（只读）。
- **日志证据**：按条数与过滤词抽取日志证据，敏感值由服务端脱敏。
- **工作流与触发规则**：查看已注册工作流、评估触发条件（只评估，不执行）。
- **MCP 服务器**：服务器状态、工具数、失败原因。
- **运行手册**：列表、统计（条数/标签/是否落盘/最近更新）、新建（只存文字，不执行）。
- **容器、设备档案、写动作与健康检查**：容器统计与异常、设备档案、待确认写动作、健康检查计划。
- **网页取证**：`POST /api/web/fetch`，默认策略关闭，因此常态是「被拒绝」，界面照实呈现 code/reason 而不重试。

## 新增界面：知识库统计与冲突

知识库页原来只展示条目列表。本轮补两块只读信息：

- **统计**：总条数、归档数、按来源、按核验状态、容量上限（来自 `GET /api/knowledge/stats`）。
- **冲突**：同一主题存在不同结论时并列展示，并明确「不做自动取舍」（来自 `GET /api/knowledge/conflicts`）。

两者都用 `textContent` 渲染，不拼 HTML —— 知识库内容是外部输入，不能进 `innerHTML`。

## 渲染与安全边界

- 新增渲染一律 `document.createElement` + `textContent`，测试锁死新增片段里不出现 `innerHTML`/`insertAdjacentHTML`/`outerHTML`。
- 所有写操作（新建运行手册）沿用既有 `POST /api/runbooks` 的配额与审批路径，没有新增旁路。
- 网页取证失败不做任何降级重试，也不回落到 Node 直连。
- 界面只显示服务端返回的结论，不在前端复算许可判定。

## 测试

新增 `tests/phase-211-ui-gap-coverage.test.mjs`，7 例全通过：

1. 24 条被审查过的路由必须在 `ui/pages.js` 或 `ui/core.js` 里出现；
2. ops 页声明的每个渲染函数必须真实存在（12 个）；
3. 新增控件 id 必须在 `index.html` 存在，且 `#ops-fetch-run` 必须绑定点击事件、`core.js` 必须把 `ops-card` 列为页面；
4. 4 条有意 API-only 的路由不得出现在前端（防回退）；
5. `refreshKnowledgeFacts` 必须是独立函数且不拼 HTML；
6. 导航必须能到「诊断与运维」；
7. 前端调用的每条 `/api/...` 字面量必须在 `server.mjs` 里真实存在（反向查死链，动态参数路由按前缀放行）。

同时回归：`tests/phase-202-http-routes.test.mjs`、`tests/phase-157-ui-integration.test.mjs`、`tests/phase-174-observation-panel.test.mjs` 共 30 例全通过。

## 遗留

- `/api/files/operations/batch` 仍未接界面：文件页没有多选模型，接它需要先做选择态，属于一次独立改动。
- `/api/knowledge/preview` + `/api/knowledge/commit`：两步写入值得做，但需要先定「谁能写知识库」的产品口径。
- `/api/tools/:id/run`：工具调用面板已有 Playbook 通道，单独开放手写参数入口会削弱「destructive 必须单独确认」的约束，暂不开放。

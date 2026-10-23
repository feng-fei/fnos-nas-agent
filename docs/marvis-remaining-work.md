# Marvis 借鉴清单：剩余工作详细列表

本文是对 `docs/marvis-feature-checklist.md`（607 行、243 个编号项）与当前代码的差距清单。
状态口径与 [marvis-capability-matrix.md](marvis-capability-matrix.md) 一致。统计时间：2026-10-23。

**总览**：243 项中 70 项已实现、133 项部分实现、4 项只做了读取面、36 项未开工。统计时间：2026-10-23（随 Phase 215 更新）。
Phase 184–215 又落地了二十余项，对照表已回填；本文件只保留「还没开工」的逐条视图，状态一律以矩阵为准。
**真正没开工的是 36 项**。下表由矩阵直接生成，不再人工维护。

---

## 一、未开工（36 项）

| 编号 | 功能 | 现状 |
| --- | --- | --- |
| A04 | Parallel task execution | 未在本仓库实现 |
| A09 | Task recovery after restart | 未在本仓库实现 |
| A13 | Task conflict detection | 未在本仓库实现 |
| F12 | Image OCR | 未在本仓库实现 |
| F14 | Photo timeline | 未在本仓库实现 |
| F16 | PDF analysis | 未在本仓库实现 |
| F17 | Document classification | 未在本仓库实现 |
| F20 | Format conversion | 未在本仓库实现 |
| F21 | Document batch processing | 未在本仓库实现 |
| F22 | File change monitoring | 未在本仓库实现 |
| C07 | Control services | 未在本仓库实现 |
| C08 | Control containers | 未在本仓库实现 |
| C09 | Change application configuration | 未在本仓库实现 |
| C10 | Adjust resource policy | 未在本仓库实现 |
| APP06 | Deployment plan | 未在本仓库实现 |
| APP09 | Deploy or update | 未在本仓库实现 |
| APP11 | Fault recovery | 未在本仓库实现 |
| APP15 | Application migration | 未在本仓库实现 |
| APP16 | Deployment rollback | 未在本仓库实现 |
| APP17 | Application backup | 未在本仓库实现 |
| APP18 | Application templates | 未在本仓库实现 |
| N11 | Network configuration change | 未在本仓库实现 |
| SEC13 | Backup pre-check | 未在本仓库实现 |
| W12 | Workflow versioning | 未在本仓库实现 |
| B01 | Web search | 未在本仓库实现 |
| B02 | Official documentation first | 未在本仓库实现 |
| B03 | Log and error-code lookup | 未在本仓库实现 |
| B05 | Page change monitoring | 未在本仓库实现 |
| B08 | Web operation planning | 未在本仓库实现 |
| B09 | Source citation | 未在本仓库实现 |
| AI04 | Task routing | 未在本仓库实现 |
| K05 | User preferences | 未在本仓库实现 |
| R05 | Alert push | 未在本仓库实现 |
| R06 | Multi-NAS management | 未在本仓库实现 |
| R07 | Device groups | 未在本仓库实现 |
| R09 | Device status sync | 未在本仓库实现 |

## 二、部分实现中的关键缺口（第一轮留档，2026-10-23）

这些不计入"未开工"，但完成度低，是运维闭环的实际断点。

1. **Agent 工具面太窄（最严重）**：`read-only-tools.mjs` 只注册 18 个工具，服务端已有 66 条路由。
   服务状态、SMART、温度、系统事件、系统快照、能力位图、容量预测、证书体检、部署前校验全部只开在 HTTP，
   模型在对话里调不到。→ Phase 203 正在做工具定义层，Lead 接线。
2. **采集器缺失，判断层空转**：网络（网关/吞吐/反代）、Docker 实时 stats、SMART NVMe、系统事件只认三种日志格式。
   → Phase 204（docker stats）、Phase 205（网络采样）、Phase 207（日志证据）正在做。
3. **写路径为零**：C07–C10、APP09/11/15–18、N11、D08–D11 全缺执行端；
   `verified-write.mjs` 只有骨架、`execution-capability.mjs` 只发票据。
4. **诊断证据源不完整（D02）**：已有审计日志、工具轨迹、健康检查、系统快照、服务状态（Phase 191），
   缺日志文件、SMART、服务事件流 → Phase 207 补日志一类。
5. **工作流缺触发与版本（W03/W12）**：引擎有依赖图、锁、通知钩子（Phase 168），缺事件源与版本管理 → Phase 206。
6. **知识库缺档案与合并（K03/K05/K08）**：条目有来源、时效、冲突检测，缺设备/用户档案与冲突合并流程 → Phase 208。
7. **通知只有中心没有投递（W10）**：有 notification-center 数据结构，没有真实投递目标。
8. **UI 覆盖不全**：多个新面板只有卡片，缺独立页面（UI03/UI04/UI05/UI06/UI07/UI08/UI09 仍是 Partly）。
9. **对照表落后于代码**：8 行需回填（本次已修正）。

---

## 三、第一轮并行执行记录（留档，2026-10-23）

| 阶段 | 内容 | 产出文件 | 对应清单 |
|---|---|---|---|
| Phase 203 | 只读事实的 Agent 工具定义层 | `app/system-tools.mjs` | S10/S06/S12/S13/S20/S15/S17 的工具化 |
| Phase 204 | Docker 实时资源采样解析与判定 | `app/docker-stats.mjs` | APP02 资源分析 |
| Phase 205 | 网络采样解析/增量/打包 | `app/network-collectors.mjs` | N03 网关、N06 吞吐、N09 反代 |
| Phase 206 | 工作流事件触发判定 | `app/workflow-triggers.mjs` | W03 事件触发（+W07 幂等、W10 去重） |
| Phase 207 | 日志证据化 | `app/log-evidence.mjs` | D02 日志关联、S13 系统事件 |
| Phase 208 | 设备与用户偏好档案 | `app/device-profile.mjs` | K03/K05/K08 |
| Phase 209 | 技能组合校验与计划 | `app/skill-composition.mjs` | SK04 技能组合、W15 复用 |

七个阶段由子代理并行实现（纯函数、零依赖、只新建文件），Lead 负责 server 路由接线、UI 入口、全量测试与提交。

---

## 四、明确不做（清单本身也建议不优先）

- **模块 13 的多设备/远程**（R06/R07/R09），单机控制台定位，且用户偏好不允许常驻自动机制。
- **B08 网页操作规划**：等于自动化浏览器，收益低、风险高。
- **C10 资源策略调整**：FNOS 无稳定接口。
- **F20 格式转换**：依赖外部工具，收益低。
- **桌面控制类功能**：清单 §21 明确不建议。

---

## 五、第一轮的后续轮次建议（留档，已被 Phase 184–215 取代）

1. 本轮七阶段交付后：接 server 路由 + UI + 全量测试 + 提交（Lead）。
2. 下一轮：写路径第一例（C07 服务控制）——预览、capability 审批、执行、前后对比验证；同时补 SEC13 备份前置检查。
3. 再下一轮：A05 依赖图 + A04 并行执行 + A08 重试 + A13 冲突检测（重构 `agent-core.mjs` 计划执行器）。
4. 之后：Docker 应用模板与部署计划（APP06/APP18）、工作流版本管理（W12）、B09 来源引用。

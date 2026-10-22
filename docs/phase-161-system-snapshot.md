# Phase 161 — 系统状态快照与健康评分

本阶段实现用户功能清单 **模块 02「系统信息理解与健康监控」** 的第一部分（S01–S12），
并为 S13–S15 显式标注「未采集」。整个阶段只有三个新文件，全部是**纯逻辑模块 + 单元测试 + 文档**：

> 一句话概括：**系统状态采集**是注入式的（`collect(sectionId)`），**健康评分**是纯函数
> （`scoreHealth(sections)`），两者之间用「数据可信原则」隔开——采不到就是采不到。

| 文件 | 作用 |
| --- | --- |
| `apps/fnos-nas-agent/app/system-snapshot.mjs` | ES module，导出 4 个函数与 3 个常量；无 I/O、无第三方依赖 |
| `tests/phase-161-system-snapshot.test.mjs` | `node --test` 用例，覆盖采集失败、全部未知等可信性场景 |
| `docs/phase-161-system-snapshot.md` | 本文档 |

明确**没有**发生的事：

- 没有修改 `apps/fnos-nas-agent/app/server.mjs`，没有新增任何 HTTP 路由；
- 没有修改 `apps/fnos-nas-agent/app/ui/**` 下的任何页面、脚本或样式；
- 没有修改任何既有模块（包括 `overview.mjs`、`trim-cli-health.mjs`、`scheduled-health-checks.mjs`）；
- 没有执行 `git commit` / `git push`。

## 1. 背景与数据可信原则

模块 02 的验收口径不是「把指标显示出来」，而是「显示的指标必须可信」。因此本阶段把
**数据可信原则**写进模块本身，而不是只写在文档里：

1. **磁盘容量必须来自系统采集接口返回的数据。** 模块自己不做任何估算、不做插值、不填默认值。
   采集结果里没有 `totalBytes` / `usedBytes`，容量就是「未采集」。
2. **硬盘健康必须有 SMART 支持才可断言。** `smart.supported !== true` 时，磁盘健康一律记为
   **未知/未采集**，绝不用「容量正常」推导成「硬盘健康」；只有 `smart.supported === true` 且
   `smart.status !== "ok"` 才会被判为硬盘异常。
3. **采集失败必须显式暴露。** 采集函数抛异常 → `status: "unavailable"`（接口不可用）；
   返回空数据 / 缺关键指标 → `status: "unknown"`（未采集）。两种情况 `values` 都是**空对象**，
   界面上不允许出现「0% 使用率」「0 B 剩余」这类看起来正常的假数据。
4. **评分必须反映数据完整度。** 未采集的 section 不参与加权，且会把总分会按「可用数据占比」打折，
   所以一个只采到 1/6 数据的系统不可能显示为健康。

## 2. 导出 API 约定

```js
import {
  buildSystemSnapshot,
  scoreHealth,
  mergeSectionValues,
  describeSectionStatus,
  DEFAULT_SECTIONS,
  DEFAULT_WEIGHTS,
  UNCOVERED_SIDS
} from "./system-snapshot.mjs";
```

| 导出 | 签名 | 返回 | 说明 |
| --- | --- | --- | --- |
| `buildSystemSnapshot` | `({ collect, sections, now } = {}) => Promise<object>` | `{ generatedAt, sections, score, uncovered }` | 依次调用 `collect(sectionId)` 收集各 section，计算健康评分 |
| `scoreHealth` | `(sections, { weights } = {}) => object` | `{ value, grade, breakdown, coverage }` | 对已归一化的 section 列表评分 |
| `mergeSectionValues` | `(a, b) => object \| Array<object>` | 同形状合并结果 | 增量刷新：同名 section 的 `values` 合并，后者覆盖同名键 |
| `describeSectionStatus` | `(status) => string` | `"正常"` / `"未采集"` / `"接口不可用"` | 前端直接展示的状态文案 |

常量：

| 常量 | 内容 |
| --- | --- |
| `DEFAULT_SECTIONS` | 6 个 section 及其 `sIds`：`cpu`(S01,S02)、`memory`(S03,S04)、`storage`(S05,S06,S07)、`network`(S08,S09)、`services`(S10,S11)、`docker`(S12) |
| `DEFAULT_WEIGHTS` | `cpu:1, memory:1, storage:2, network:1, services:1, docker:1`（存储权重更高） |
| `UNCOVERED_SIDS` | `S13` / `S14` / `S15`，note 均为「本阶段未采集」 |

### 2.1 采集器契约

```js
const collect = async (sectionId) => ({
  status: "ok" | "unknown" | "unavailable",
  values?: object,
  note?: string
});
```

- `status: "ok"` 时 `values` 必须包含该 section 的可度量指标，否则会被**降级**为
  `status: "unknown"`、`values: {}`，note 为「采集接口未返回可用数据」；
- 采集器抛异常时不会中断整个快照，异常被记为该 section 的 `status: "unavailable"`，
  note 为「采集接口调用失败」；
- 未提供 `collect` 时，所有 section 均为 `unknown`，评分为 `unknown`。

### 2.2 各 section 的期望 `values`

| section | 期望字段 | 缺失时的处理 |
| --- | --- | --- |
| `cpu` | `usagePercent`（可选 `temperatureC`） | 无 `usagePercent` → unknown |
| `memory` | `usedPercent`（可选 `totalBytes` / `availableBytes`） | 无 `usedPercent` → unknown |
| `storage` | `disks[]`，每项 `{ name, totalBytes, usedBytes, smart: { supported, status } }` | 无有效容量 → unknown；SMART 不支持 → 健康标为未知/未采集但容量仍参与评分 |
| `network` | `online`（布尔，可选 `latencyMs`） | 无 `online` → unknown |
| `services` | `total` / `failed` | 任一缺失或 `total<=0` → unknown |
| `docker` | `available`、`containersTotal`、`containersRunning` | `available === false` 或缺计数 → unknown |

### 2.3 评分与分级

- 单项得分：CPU/内存/存储按使用率分档（<70% → 100，<85% → 75，<95% → 45，否则 20）；
  存储若存在 SMART 异常则该项封顶 20；网络离线 25、延迟 ≥300ms 60、≥150ms 85；
  服务按 `failed/total` 扣分；容器按 `running/total` 比例。
- 汇总：`value = round(加权平均分 × 可用数据占比)`，取值 0–100。
- 分级：`good` ≥ 80，`fair` ≥ 60，其余 `poor`；**可用数据占比 < 34% 时一律 `unknown`**，
  因为此时分数不可信；全部 section 不可用时 `value = 0`、`grade = "unknown"`。
- `breakdown` 每项为 `{ id, weight, score, reason }`：未采集的 section `score` 为 `null`，
  `reason` 为「数据未采集」或「数据未采集（接口不可用）」。

## 3. 与功能清单的对应关系（供 Phase 159 对照矩阵）

| 编号 | 能力 | 本阶段 section | 状态 |
| --- | --- | --- | --- |
| S01 | CPU 型号 / 核心数 | `cpu` | 采集侧提供，模块只消费 `usagePercent` / `temperatureC` |
| S02 | CPU 负载与温度 | `cpu` | 已覆盖 |
| S03 | 内存总量 | `memory` | 已覆盖（`totalBytes` / `availableBytes`） |
| S04 | 内存占用率 | `memory` | 已覆盖 |
| S05 | 磁盘容量（来自采集接口） | `storage` | 已覆盖 |
| S06 | 硬盘健康（SMART） | `storage` | 已覆盖：SMART 缺失时显示未知/未采集 |
| S07 | 多盘 / 存储池概览 | `storage` | 已覆盖（`disks[]` 逐盘统计） |
| S08 | 网络接口与连通性 | `network` | 已覆盖 |
| S09 | 网络延迟 | `network` | 已覆盖（`latencyMs`） |
| S10 | 系统服务运行状态 | `services` | 已覆盖 |
| S11 | 异常服务计数 | `services` | 已覆盖（`failed`） |
| S12 | 容器运行状态 | `docker` | 已覆盖 |
| S13 | 本阶段未覆盖 | — | **未采集**（`UNCOVERED_SIDS`） |
| S14 | 本阶段未覆盖 | — | **未采集** |
| S15 | 本阶段未覆盖 | — | **未采集** |

本阶段结论：**模块 02 共覆盖 S01–S12 共 12 项；S13、S14、S15 三项显式标注为「未采集」，
不伪装成已实现。** 快照对象的 `uncovered` 字段把这三项原样带给前端与对照矩阵。

## 4. 设计要点

1. **注入式采集，纯逻辑内核。** 模块不 `import` 任何传输层（TRIM CLI、HTTP、脚本），
   采集通道由集成层决定。测试可以用一个纯函数模拟整个 NAS。
2. **状态只有三种，且不可被"猜"成 ok。** `normaliseStatus()` 把任何未知取值归一到
   `unknown`；`status === "ok"` 但指标不可用时再降级一次。两道关卡保证「正常」二字
   只在真有数据时出现。
3. **空 values 恒为空对象。** 未采集的 section `values` 是 `{}`，不是 `null`、不是
   `{ usagePercent: 0 }`。前端拿不到可以误当数值的字段。
4. **评分惩罚数据缺失。** 未采集 section 权重不计入分子，但计入分母并折算成 coverage，
   `value` 随 coverage 线性下降；coverage 过低时直接 `unknown`。
5. **评分明细可读。** `breakdown[].reason` 用中文写明「容量占用最高的磁盘 sda 已用 82%；
   硬盘健康未知/未采集（1 块磁盘不支持或未返回 SMART）」这类事实，便于直接展示与排障。
6. **增量刷新安全。** `mergeSectionValues()` 只做 values 合并，后到的键覆盖先到的键；
   状态不会被 `unknown` 覆盖已有的 `ok`，避免一次局部刷新把整体降级成「未采集」。
7. **永不抛异常。** 采集器异常、时钟异常、代理对象 getter 异常都被吞掉并降级为
   明确的未知状态，快照始终返回完整形状。

## 5. 未修改的接线

本阶段**没有**接入页面与后端路由。后续集成步骤：

1. 在 `app/server.mjs` 中注入一个真实的采集器（可用 `trim-cli-health.mjs` 或新写的
   采集适配器），实现 `collect(sectionId)`，其中 `storage.disks[]` 必须来自系统采集接口，
   `smart` 字段只有在确实执行了 SMART 读取时才填 `supported: true`。
2. 新增一个只读 HTTP 路由返回 `buildSystemSnapshot()` 的结果，前端按 `sections[].status`
   渲染：非 `ok` 时显示 `describeSectionStatus(status)` 的文案，而不是「正常」。
3. UI 需要同时展示 `snapshot.uncovered`（S13–S15 未采集），避免在对照矩阵里留下空白。

## 6. 测试清单

```bash
node --test tests/phase-161-system-snapshot.test.mjs
```

共 **22** 个用例，全部通过（`# pass 22 / # fail 0`）：

| # | 用例 | 覆盖点 |
| --- | --- | --- |
| 1 | buildSystemSnapshot exposes the six fixed default sections | 默认 section 集合与 `generatedAt` |
| 2 | default sections record the S-numbers of module 02 they answer | S01–S12 映射与 S13–S15 未采集 |
| 3 | a healthy system scores good when every section is collected | 全采集时 `good` |
| 4 | a failing collector never produces normal looking values | 采集抛异常 → unavailable + 空 values + unknown 评分 |
| 5 | a section without data stays unknown instead of being filled with defaults | 未采集不填默认值 |
| 6 | a collector reporting ok without usable data is downgraded to unknown | 「假 ok」降级 |
| 7 | an unknown status does not contribute to the weighted score | 未采集不参与加权 |
| 8 | all sections unknown results in grade unknown | 全部未知 → `grade=unknown` |
| 9 | all sections unavailable results in grade unknown | 全部不可用 → `grade=unknown` |
| 10 | the value reflects the share of collected data | 评分随数据占比下降 |
| 11 | an explicit weight override changes the weighted result | `weights` 覆盖生效 |
| 12 | a low coverage is graded unknown because the score is not trustworthy | coverage < 34% → unknown |
| 13 | a full disk lowers the storage score | 磁盘接近写满 → 存储分下降 |
| 14 | a failing SMART disk is reported and caps the storage score | SMART 异常 |
| 15 | a disk without SMART support is reported as unknown health, not as healthy | SMART 缺失 → 未知/未采集 |
| 16 | disk capacity without a total size yields an unknown storage section | 缺容量 → unknown |
| 17 | mergeSectionValues merges section values with the later payload winning | 增量合并，后者覆盖 |
| 18 | mergeSectionValues accepts a single section object | 单对象合并 |
| 19 | mergeSectionValues keeps a known status over an unknown one | 局部刷新不降级状态 |
| 20 | describeSectionStatus returns the Chinese labels | 三种状态文案 |
| 21 | the snapshot reports the S-numbers that are not collected in this phase | `uncovered` 输出 |
| 22 | the module performs no I/O on its own and never throws | 无采集器时全部 unknown |

## 7. 后续建议

1. 补齐 S13–S15 的采集实现时，请沿用本模块的采集器契约，不要绕过 `buildSystemSnapshot`
   直接写新路由，否则「未知/未采集」的口径会分裂。
2. SMART 读取应做超时与权限失败处理：读取不到时 `smart.supported` 必须为 `false` 或字段缺失，
   绝不能因为命令返回 0 就当成「健康」。
3. 后续若引入历史趋势（连续快照对比），建议在 `business.db` 侧另建表记录每次快照的
   `generatedAt` / `score.value` / `score.grade`，不要写进 `user_personas` 等既有语义表。
4. 阈值（70/85/95 使用率分档、34% coverage 下限、80/60 分级线）目前写死在模块内，
   若需要可配置，可在下一阶段以 `options.thresholds` 形式注入，保持默认值不变。

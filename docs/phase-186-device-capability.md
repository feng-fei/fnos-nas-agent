# Phase 186 — 设备能力体检（逐维判定，不猜）

## 背景

商店版 Marvis 的运行时代码里有一个 `DeviceProfile`，它按 L1–L7 七个维度判断“这台机器能不能跑本机模型”，并把每一项的答案显式写出来（平台、架构、CPU 核心、内存、存储类型、指令集、磁盘余量）。逆向这层能力后得出的结论是：**最有价值的部分不是“打分”，而是逐维度的判定结果与缺口说明**——用户能看懂“为什么不行”，运维能据此做迁移决策。

本仓库此前没有任何“这台机器适合跑什么”的入口：`collector` 只报当前状态，`docker-advisor` 只报容器建议。于是把 `DeviceProfile` 的逐维判定搬进来，作为只读能力。

## 实现

新增 `apps/fnos-nas-agent/app/device-capability.mjs`（纯函数、零 I/O、零第三方依赖）：

| 导出 | 契约 |
| --- | --- |
| `DEVICE_PROFILES` | `agent-host` / `local-llm` 两套阈值 |
| `CAPABILITY_DIMENSIONS` | 5 个维度的 id / 标签 / 更高是否更好 |
| `deviceEnvironment(overrides)` | 由 `os` 侧参数组装环境对象，缺项保持未知 |
| `evaluateDeviceCapabilities(environ, { profile })` | 逐维判定，返回结论 |

`evaluateDeviceCapabilities` 返回：

```js
{
  profile: "agent-host" | "local-llm",
  verdict: "ready" | "partial" | "not-ready",
  passed, failed, unknown, total,
  dimensions: [{ id, label, required, actual, passed: true|false|null, higherIsBetter }],
  recommendation: "……"
}
```

判定语义（与 Marvis 一致的三态设计）：

- `passed: true` — 达到要求；
- `passed: false` — 不达到，`required` 与 `actual` 同时给出；
- `passed: null` — **未知**，例如存储类型无法从进程侧读取。未知永远不算通过，也永远不猜。

结论聚合规则：任一维度为 `false` → `not-ready`；全部为 `true` → `ready`；其余（含存在未知）→ `partial`。`recommendation` 永远跟着具体缺口走，不会只说“性能不足”。

## API

`GET /api/system/capabilities?profile=agent-host|local-llm`

- 未登录 `401`；未知 profile `400`（不回退默认值）；非 GET `405`；
- 审计路由名 `system.capabilities`；
- 存储类型无法读取时，响应里的 `note` 会提示可用 `AGENT_STORAGE_TYPE=ssd|hdd` 显式声明，再查看结论。

## 前端

概览页新增「设备能力体检」卡片：两个按钮分别检查「本助手」与「本地模型」条件，结果为逐行文本（`textContent`，不拼 HTML）；样式复用既有 `details.card` 结构，不新增页面。文件页工具栏同时补了「查找重复」入口（Phase 184 的扫描能力此前只有 API，没有按钮），结果只读展示分组与可回收空间。

## 与 Marvis 的差异（有意为之）

- 不读 `/proc`、不读 SMART、不探测磁盘类型：只有进程侧能拿到的数据才参与判定，拿不到就报未知；
- 不引入本地模型运行时（Marvis 的 `LocalLLMManager`）：本仓库的定位是 NAS 助手，推理走已配置的云端模型；
- 不因能力不足自动降级或改动系统：结论只用于说明与决策。

## 测试

`tests/phase-186-device-capability.test.mjs`（7 例，全通过）：

1. `agent-host` 在 4C/4GB Linux 上为 `ready`；
2. `local-llm` 在 4C/16GB 上为 `partial`，CPU 维度给出 `≥ 8 核` 与 `4 核`；
3. 平台不符为 `not-ready`，建议文案指向平台；
4. 空环境全为未知，结论 `partial`，不静默通过；
5. 32 位架构 + HDD 被判定且给出 `32 位` / `固态硬盘`；
6. 未知 profile 回退保守的 `agent-host`；
7. HTTP：未登录 401、未知 profile 400、正常 200 且 `dimensions` 为 5 项、POST 405。

## 遗留

- 指令集与磁盘余量尚未纳入（需要平台相关探测，暂不引入）；
- 结论未持久化：每次请求现算，避免缓存误导；
- 概览卡片不自动刷新，避免登录后立即发起多次系统探测。

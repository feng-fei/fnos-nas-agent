# Phase 197 — 设备诊断接线（温度 / 系统事件 / SMART / 升级检查）

## 背景

Phase 192–196 交付了四层纯逻辑（SMART 解析、温度归一、日志事件解析、版本比较）和两个只读采集器（`/sys/class/thermal`、日志尾部）。这些层当时没有任何出口：没有路由、没有按钮、没有测试从 HTTP 打进去。这一阶段把它们接起来，并在概览页的「服务状态与容量趋势」卡片里加一段「设备诊断」。

同一批交付里的位置关系：

| 阶段 | 交付 | 本阶段如何用 |
| --- | --- | --- |
| 192 | `smart-health.mjs` | `parseSmartInfo` / `parseSmartAttributes` → `summarizeSmartHealth` |
| 193 | `thermal-status.mjs` | `normalizeThermalReadings(collector.readings)` → `summarizeThermals` |
| 194 | `system-events.mjs` | `parseLogLines(text)` → `summarizeEvents(events, {limit})` |
| 195 | `update-check.mjs` | `buildUpdateVerdict({current: APP_VERSION, latest, channel})` |
| 196 | `thermal-collector.mjs`、`log-tail-collector.mjs` | 路由调用 |
| 197 | `smart-collector.mjs`、4 条路由、UI 段落、本测试 | ← 本阶段 |

## 新增与改动

| 文件 | 变更 |
| --- | --- |
| `apps/fnos-nas-agent/app/smart-collector.mjs` | 新增。`smartctl -H -A` 只读采集，设备名来自 `/sys/block` 白名单，最多 8 块 |
| `apps/fnos-nas-agent/app/server.mjs` | 新增 4 条路由、3 个采集器实例、4 个审计 routeName |
| `apps/fnos-nas-agent/app/ui/index.html` | 「服务状态与容量趋势」卡片改名并新增 `#runtime-devices` |
| `apps/fnos-nas-agent/app/ui/pages.js` | `refreshRuntime()` 并发读取 4 条新接口，`renderDeviceDiagnosis()` 纯文本渲染 |
| `tests/phase-197-device-routes.test.mjs` | 新增。6 个用例：采集器 4 个 + 路由行为 2 个（含真实子进程 + 登录会话） |

## 接口

四个都是只读 `GET`，都要登录会话；写方法一律 405。

| 路由 | 参数 | 成功返回要点 |
| --- | --- | --- |
| `GET /api/system/thermal` | 无 | `verdict`（ok/warm/hot/unknown）、`counts`、`hottest`、`readings`、`dropped`、`notes` |
| `GET /api/system/events` | `limit`（1–50，缺省 20） | `verdict`、`counts`（按级别）、`repeated`、`dropped`、`sources`、`notes` |
| `GET /api/system/smart` | 无 | `verdict`（最坏优先）、`devices: [{device, verdict, findings, notes}]`、`notes` |
| `GET /api/system/update-check` | `latest`（≤64 字符）、`channel`（stable/beta/any） | `status`、`current`、`latest`、`channel`、`installedVersion`、`notes` |

审计 routeName：`system.thermal`、`system.events`、`system.smart`、`system.update-check`。

## 语义与安全边界

1. **没测到就说没测到**：三个采集型接口在没有权限/没有文件/采集器被关闭时返回 `unknown`，`notes` 里写明 `collector-disabled` / `collector-failed` / `no-thermal-zone` / `unreadable:<path>`，`note` 字段用中文明确「这不代表设备正常」。UI 的结论行同理会显示「未知」。
2. **固定输入面**：温度只读 `/sys/class/thermal`；日志只读构造时写死的三条绝对路径；SMART 设备名来自 `/sys/block` 正则白名单（`sd*`/`nvme*n*`/`vd*`/`hd*`），最多 8 块。请求只能给 `limit`、`latest`、`channel` 三个标量，不能指定文件、设备或命令。
3. **固定 argv、无 shell**：`execFile("smartctl", ["-H","-A","/dev/sda"])`，超时 8s，输出上限 64 KiB；`-H -A` 不带任何会改盘状态的参数。
4. **SMART 默认关闭**：`smartctl` 需要裸设备读权限，商店版应用通常没有，所以只有 `FNOS_AGENT_SMART_COLLECTOR=on` 时才尝试；否则直接回 `collector-disabled` 并说明怎么打开。温度与日志可用 `FNOS_AGENT_THERMAL_COLLECTOR=off`、`FNOS_AGENT_LOG_COLLECTOR=off` 关闭。
5. **升级检查不联网**：`latest` 由调用方提供，服务端只做纯比较；不提供就是 `unknown`（`latest-missing`），降级是 `unknown` + `downgrade-not-offered`，`channel` 非法值是 400。这样「检查更新」不会在用户不知情时向外发请求。
6. **SMART 汇总取最坏**：任何一块盘 `failed` 就是 `failed`；只有全部 `ok` 才是 `ok`；某块盘 `unknown` 会让整体 `unknown`（除非另有更坏的结论）。
7. **UI 一律 `textContent`**：新增段落不拼 HTML，与 Phase 157 的守护断言一致。

## 测试结果

`node --test tests/phase-197-device-routes.test.mjs` → **6 tests / 6 pass / 0 fail**：

- 采集器：白名单与固定 argv（`["-H","-A","/dev/..."]`、无 shell、有超时）、非零退出但 stdout 有内容时继续解析、单盘失败不影响其它盘、无盘时 `no-smart-device`、超 8 块截断。
- 路由：未登录 401（含 POST）、写方法 405、采集器关闭时三个接口 `verdict=unknown` 且带 `collector-disabled`、`update-check` 的 `update-available` / `latest-missing` / `downgrade-not-offered` / 非法 channel 400。
- Windows 上另跑一次真实服务：温度 `collector-failed`、事件 `unreadable:*`，两者都如实 `unknown`。

模块自测：Phase 192 → 23/23、193 → 28/28、194 → 24/24、195 → 31/31、196 → 17/17。

## 遗留

- **NVMe 未覆盖**：`smartctl -A` 在 NVMe 上不是 ATA 属性表，Phase 192 按设计会得到 `no-attributes/unknown`；需要单独解析 NVMe SMART/Health Information 日志页。
- **温度阈值未标定**：65/80 是通用值，未按 HDD/SSD/NVMe/SoC 区分，也未做历史趋势。
- **SMART 未真机验证**：本机（Windows）没有 `/sys/block` 与 `smartctl`；fnOS 上需要 `FNOS_AGENT_SMART_COLLECTOR=on` 且应用有裸设备权限才有读数。
- **日志格式有限**：只认 kmsg 前缀、journalctl short、`LEVEL: msg` 三种；多行堆栈从第二行起可能被计为 dropped。
- **升级检查无拉取层**：不联网、无缓存、无签名校验；`latest` 的来源与可信度由调用方负责。

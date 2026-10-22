# Phase 196 — 温度与日志采集器

## 背景

Phase 190 的服务状态、Phase 193 的温度判定、Phase 194 的事件解析都是纯函数：它们只描述「拿到数据之后怎么判断」，不碰系统。这一阶段补上采集侧，把 fnOS 上两个只读数据源接进判断层：

- **温度**：`/sys/class/thermal/thermal_zoneN/{temp,type}`。J4125 这类平台通常有 `x86_pkg_temp`、`acpitz`、`nvme` 几个 zone，毫摄氏度整数，普通用户可读，不需要 root，也不依赖 `lm-sensors`。
- **事件**：`/var/log/{syslog,messages,kern.log}` 的尾部。不是所有系统都能读到（取决于日志配置与权限），所以采集器把「读不到」当作正常情况留痕，而不是报错。

## 新增文件

| 文件 | 作用 |
| --- | --- |
| `apps/fnos-nas-agent/app/thermal-collector.mjs` | 读 `thermal_zoneN`，产出 `thermal-status.mjs` 需要的 `{source,label,raw,unit}` 列表 |
| `apps/fnos-nas-agent/app/log-tail-collector.mjs` | 从固定白名单日志文件读最后 ≤64 KiB 文本 |
| `tests/phase-196-collectors.test.mjs` | 17 个用例，两个采集器各 9 / 8 个，全部通过 |

## 导出 API

### `thermal-collector.mjs`

- `THERMAL_ROOT = "/sys/class/thermal"`、`MAX_THERMAL_ZONES = 32`、`MAX_LABEL_LENGTH = 60`
- `createThermalCollector({ root, readDir, readFile })` → `collectThermalZones()`
  - 返回 `{ readings: [{ source, label, raw, unit: "milliCelsius" }], notes: string[] }`
  - `source` 保留 `thermal_zoneN`（原始、稳定），`label` 取 `type`（缺失则回落成 zone 名），`raw` 是文件原文（只 trim）
  - 只认 `/^thermal_zone\d+$/`，按编号数字序排序（`thermal_zone2` 在 `thermal_zone10` 之前）

### `log-tail-collector.mjs`

- `DEFAULT_LOG_PATHS = ["/var/log/syslog", "/var/log/messages", "/var/log/kern.log"]`、`MAX_LOG_BYTES = 65536`
- `createLogTailCollector({ paths, maxBytes, fs })` → `collectLogTail()`
  - 返回 `{ text, notes: string[], sources: string[] }`
  - 每个文件只读尾部 `min(size, maxBytes)` 字节（`readSync` 带偏移），多文件用 `\n` 拼接
  - 白名单在**构造时**过滤：只保留以 `/` 开头的路径，请求方无法注入路径

## 语义与安全边界

1. **只读**：两个采集器都只开读句柄；`openSync(path, "r")` 后必定 `closeSync`（`finally`），读取抛错也不漏关。
2. **不猜**：读不到的 zone 记 `temp-unreadable:<zone>` 并跳过，绝不补 `0℃`；整段没有读数时给 `no-thermal-zone`，由判定层输出 `unknown`。
3. **固定目录与白名单**：温度只读 `THERMAL_ROOT` 下匹配正则的子目录；日志只读构造时给定的绝对路径，不支持通配、不支持跟随软链之外的扩展。
4. **有界**：最多 32 个 zone、标签截断 60 字符、单文件尾部 64 KiB，避免在异常系统上拉入巨量数据。
5. **可注入**：`readDir`/`readFile`/`fs` 都是注入点，测试不触碰真实 `/sys` 与 `/var/log`。
6. **失败分层**：`readDir` 抛错直接向上抛（根目录不可读 = 采集不可用，路由据此处成 `collector-failed`）；单个文件/zone 失败只留痕。

## 测试结果

`node --test tests/phase-196-collectors.test.mjs` → **17 tests / 17 pass / 0 fail**。覆盖：编号排序、非 zone 目录过滤、缺 `type` 回落、标签截断、32 个上限、空目录、根目录不可读抛错、注入点类型校验；尾部读取偏移与长度、多文件拼接、非绝对路径过滤、空文件/非普通文件、`read` 返回 0、`read` 抛错仍关 fd、`maxBytes` 非法回落默认值。

## 遗留

- Windows 开发机没有 `/sys/class/thermal` 与这些日志文件，真实采集只能在 fnOS 上验证；接口在采集失败时必须如实返回 `unknown`。
- SMART（`smartctl`）需要 root 或宿主机命名空间，商店版应用拿不到，因此按「宿主采集器默认关闭」处理（见 Phase 192/197 文档）。
- 日志尾部可能截断在一行中间，解析层需要容忍首行残缺。

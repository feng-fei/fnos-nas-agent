# Phase 207 — 日志证据化层（D02 日志关联 / S13 系统事件）

## 背景

`apps/fnos-nas-agent/app/diagnostic-evidence.mjs` 目前的诊断证据源只有四个：

| 证据源 | 内容 | 现状 |
| --- | --- | --- |
| `audit` | 审计日志条目 | 已接 |
| `trace` | 工具调用轨迹 | 已接 |
| `health-check` | 健康检查结果 | 已接 |
| `snapshot` | 配置/快照摘要 | 已接 |

清单 **D02（日志关联）** 目前只覆盖审计日志与工具轨迹，**日志文件与内核事件缺失**（见 `docs/marvis-capability-matrix.md:74`）；**S13（系统事件）** 也还没有把系统日志行转成可引用的证据（见 `docs/marvis-capability-matrix.md:57`）。`app/system-events.mjs` 虽然能解析日志行，但产出的是事件流，不带诊断分类、脱敏与聚合。

本期新增一个纯函数模块，把**调用方已经读到的日志文本**变成可排序、可引用、已脱敏的证据条目，供 `diagnostic-evidence.mjs` 消费：

```text
日志文本 ──parseLogLines──▶ entry[] ──classifyLogLine──▶ category/severity
        ──buildLogEvidence──▶ evidence[]（窗口合并 + 脱敏 + 截断 + 排序 + 限量）
```

边界：**模块不做任何 I/O**，不读真实日志文件、不执行命令、不拼接命令；日志文本一律由调用方传入。真实日志读取仍由 `app/log-tail-collector.mjs`（或 Lead 侧采集器）负责，接线见文末「遗留与接线」。

## 新增文件

| 文件 | 作用 |
| --- | --- |
| `apps/fnos-nas-agent/app/log-evidence.mjs` | 日志证据化纯函数模块（零 import、零第三方依赖） |
| `tests/phase-207-log-evidence.test.mjs` | 28 个 `node:test` 用例，锁定解析、分类、合并、脱敏与安全红线 |
| `docs/phase-207-log-evidence.md` | 本文档 |

本期只新增上述文件，未修改任何已有文件。

## 模块 API

| 导出 | 类型 | 说明 |
| --- | --- | --- |
| `LOG_SOURCES` | `readonly string[]` | `["kernel","syslog","docker","trim"]`；未知来源归一为 `syslog` |
| `MAX_LINES` | `5000` | 单次解析最多保留的物理行数（取最新） |
| `MAX_EVIDENCE` | `40` | 单次证据构建最多保留的条数 |
| `MAX_DETAIL_LENGTH` | `240` | 单条 `detail` 的最大 Unicode 码点数 |
| `LOG_CATEGORIES` | `readonly string[]` | `["io-error","oom","disk","network","permission","service","unknown"]` |
| `LOG_SEVERITIES` | `readonly string[]` | `["info","warning","critical"]`（升序） |
| `LOG_KEYWORDS` | `readonly object[]` | 关键词表，**顺序即优先级**，便于测试与调用方检查 |
| `parseLogLines(text, { source = "syslog" })` | 函数 | 返回 `{ entries, truncated }` |
| `classifyLogLine(entry)` | 函数 | 返回 `{ category, severity }` |
| `buildLogEvidence(entries, { limit = MAX_EVIDENCE, groupWindowMs = 60000 })` | 函数 | 返回 `{ evidence, groups }` |
| `redactLogLine(text)` | 函数 | 返回脱敏后的单行文本 |

`entry` 形状：

```js
{ lineNumber, at: string | null, level, message, raw: string, source }
```

`evidence` 条目形状：

```js
{ source: "log", category, severity, count, firstAt, lastAt, detail }
```

`groups` 条目是同一合并组的**结构摘要**（不含 `detail`）：`{ category, severity, count, firstAt, lastAt }`。`groups.length > evidence.length` 表示证据被 `limit` 截断。

## 三种输入格式

### ① syslog 短格式（RFC 3164 风格）

```text
Oct 23 01:12:33 nas app[123]: connection refused
```

- `at` 原样保留 `Oct 23 01:12:33`（该格式**没有年份**，不补年份、不编日期；展示或排序时由调用方决定如何补全）；
- `level` 固定为 `notice`（该格式没有级别字段，不猜级别）；
- `message` 为 `app[123]:` 之后的部分（前导空格去掉）；
- `source` 取调用方传入的 `{ source }`。

> 任务书原文写作「RFC 3161 风格」，但 RFC 3161 是时间戳协议（TSP），上述日志短格式的规范是 **RFC 3164**。实现按 RFC 3164 风格处理，本文档按实际规范命名。

### ② ISO 时间戳 + 级别

```text
2026-10-23T01:12:33.123+08:00 ERROR connection refused
2026-10-23T01:12:34.000+08:00 [WARN] disk almost full
2026-10-23T01:12:35.000+08:00 INFO: service ready
```

- `at` 保留原 ISO 文本（含时区/毫秒）；
- 级别记号支持 `[WARN]`、`WARN:`、`WARN` 三种写法，别名表把 `error/err`、`warn/warning` 等归一到 syslog 八级（`emerg/alert/crit/err/warning/notice/info/debug`）；无法识别的级别记号不吞内容，整段按 `message` 处理；
- 时间戳形态匹配但日期非法（如 `2026-99-99T99:99:99Z`）时，**不丢原文**：整行按「无时间戳」兜底，`at = null`、`message` = 整行。

### ③ docker json-file

```json
{"log":"Buffer I/O error on dev sda\n","stream":"stderr","time":"2026-10-23T01:12:33.123456789Z"}
```

- `message` 取 `log` 字段（去掉尾部换行），**不是**整段 JSON；
- `at` 取 `time` 字段；
- `stream` 不是级别字段：`stderr` 不抬升 severity，`level` 固定为 `notice`；
- 带字符串 `log` 字段的 JSON 对象才算 docker 行；其余 JSON 交给普通行解析。

### 兜底规则

- 无时间戳、时间戳非法、无法匹配任何格式：`at = null`、`level = "notice"`、`message` = 整行内容，**不丢行**；
- 空行跳过，但仍占物理行号；
- 去掉文本末尾换行后再切行，所以「5000 行 + 末尾换行」不会被误判成 5001 行；
- 超过 `MAX_LINES` 时只解析**最新的 5000 行**，`lineNumber` 仍为原文中的物理行号（1 起），并返回 `truncated: true`；
- 非字符串输入（`null`、数字等）返回 `{ entries: [], truncated: false }`，不抛异常。

## 分类表

关键词表 `LOG_KEYWORDS` 的**顺序即优先级**，按「根因优先」排列：一条 message 命中多条规则时取第一条（例如 `Failed to start: No space left on device` 归 `disk` 而不是 `service`）。

| 顺序 | category | 关键词（示例，完整见 `LOG_KEYWORDS`） | 关键词级别 |
| --- | --- | --- | --- |
| 1 | `oom` | `Out of memory`、`oom-killer`、`Cannot allocate memory`、`memory exhaustion` | `critical` |
| 2 | `io-error` | `Buffer I/O error`、`I/O error`、`Input/output error`、`medium error`、`unrecovered read error` | `critical` |
| 3 | `disk` | `No space left on device`、`disk quota exceeded`、`read-only file system`、`filesystem is full` | `critical` |
| 4 | `network` | `connection refused`、`connection reset`、`connection timed out`、`no route to host`、`network is unreachable` | `warning` |
| 5 | `permission` | `Permission denied`、`Operation not permitted`、`authentication failure`、`EACCES`、`EPERM` | `warning` |
| 6 | `service` | `Failed to start`、`Failed to restart`、`start request repeated too quickly`、`main process exited` | `warning` |
| — | `unknown` | 以上都不命中 | 级别基线 |

`severity` 规则：**`max(级别基线, 关键词级别)`，只升级、不降级**。

| 级别基线 | 来源级别 |
| --- | --- |
| `critical` | `emerg` / `emergency` / `panic` / `alert` / `crit` / `critical` / `fatal` |
| `warning` | `err` / `error` / `warning` / `warn` |
| `info` | `notice` / `info` / `information` / `debug` / `trace` / 未知级别 |

即：`crit` 级别配 `connection refused`（关键词 `warning`）仍是 `critical`；`info` 级别配 `Out of memory` 升为 `critical`。没有任何关键词命中时 `category = "unknown"`、`severity = 级别基线`；空 message 同样归 `unknown`，不猜故障类别。

## 脱敏规则

`redactLogLine(text)` 的替换顺序（顺序有意义：先去掉转义序列，再处理凭据，最后清控制字符）：

| 顺序 | 规则 | 示例输入 → 输出 |
| --- | --- | --- |
| 1 | 去掉 ANSI CSI / OSC 转义序列 | `\x1b[31mERROR\x1b[0m` → `ERROR` |
| 2 | 密钥赋值：只替换**值**，保留键名与分隔符 | `password=hunter2` → `password=[redacted]`；`token: abc123` → `token: [redacted]`；`secret="top secret value"` → `secret=[redacted]` |
| 3 | 常见令牌形态：`sk-…`、`ghp_…`、`AKIA…` | `sk-proj-abc123DEF456ghi` → `[redacted]` |
| 4 | Bearer 凭据 | `Authorization: Bearer eyJ…` → `Authorization: Bearer [redacted]` |
| 5 | 本机 home 目录前缀：`/home/<user>`、`/Users/<user>`、`/root`、`C:\Users\<user>` | `/home/alice/.ssh/id_rsa` → `[redacted]/.ssh/id_rsa`；`C:\Users\Administrator\AppData` → `[redacted]\AppData` |
| 6 | C0 控制字符与 DEL 转空格，随后压缩连续空白 | 含 `\x00`、`\x07` 的行 → 空格式的普通文本 |

- 第 2 步的键名白名单：`pass` / `password` / `passwd` / `token` / `secret` / `api_key` / `api-key` / `credential`；值支持裸值、单引号、双引号三种写法；
- 第 5 步**只抹掉前缀、保留路径其余部分**：证据仍可读（能看到 `/ .ssh/id_rsa`），但用户名不落盘；路径前一个字符是 word/`.`/`/`/`-` 时不匹配，避免误伤 URL（如 `https://example.com/home/alice` 中的片段不会被当成 home 路径）；
- `buildLogEvidence()` 里每组 `detail` 取组内最早一条 message，**先 `redactLogLine()`、再按码点截断**到 240 个码点；超出时取前 239 个码点加 `…`，不会把代理对（emoji 等）切成两半；
- `detail` 与 `groups` 都不携带 `entry.raw`；`raw` 只在模块内部用于分类匹配与兜底，不写入证据。

## 合并窗口语义

`buildLogEvidence(entries, { limit = 40, groupWindowMs = 60000 })`：

1. **预处理**：过滤非对象 entry；`at` 重新校验（非法 → `null`）；逐条调用 `classifyLogLine()`；`detail` 先脱敏再截断。
2. **时间排序**：有时间的按 epoch 升序（同时间保持输入顺序），无时间的排在最后。
3. **窗口合并**（会话窗口，不是固定分桶）：
   - 键 = `category + severity`；同一键的相邻两条，若时间差 `≤ groupWindowMs`（默认 60s）就并入同一组，否则另起一组；
   - 组内 `firstAt` 取第一条时间、`lastAt` 取最后一条时间；
   - **无时间戳的 entry 无法参与窗口比较**：同一 `category+severity` 的无时间 entry 合并成单独一组，`firstAt = lastAt = null`，不与有时间的组混合。
4. **`detail`**：取组内时间最早的一条 message（无时间则输入顺序最靠前），脱敏 + 截断后作为该组明细；其余行只贡献 `count`，原文不入证据。
5. **`evidence` 排序**：`severity` 降序 → `count` 降序 → `firstAt` 升序（无时间排最后）→ `category` 字典序 → 输入顺序；排序完全确定，同一输入永远得到同一顺序。随后取前 `limit` 条（`limit = 0` 得到空数组，但 `groups` 仍完整）。
6. **`groups`**：全部合并组的结构摘要（不截断），用于统计与「被 limit 截断」的判断。
7. **健壮性**：空数组、`null`、非数组输入返回 `{ evidence: [], groups: [] }`；非法 `limit`/`groupWindowMs` 回落到默认值，不抛异常。

## 测试结果

```text
node --test tests/phase-207-log-evidence.test.mjs
# tests 28
# pass 28
# fail 0

node --check apps/fnos-nas-agent/app/log-evidence.mjs
# SYNTAX_OK
```

覆盖分组（共 28 例）：

| 分组 | 用例数 | 覆盖点 |
| --- | --- | --- |
| 常量与关键词表 | 2 | 常量值/冻结、分类与级别枚举、关键词表结构 |
| 三种格式解析 | 5 | RFC 3164、ISO + 级别别名、docker json-file、无时间戳、非法时间戳兜底 |
| `MAX_LINES` 截断 | 2 | 超限取最新 5000 行并保留原行号；恰好 5000 行 + 末尾换行不误判 |
| 分类与级别 | 5 | 七类分类、critical 关键词升级、`crit` 不降级、根因优先（disk > service）、unknown 基线 |
| 窗口合并 | 3 | 60s 窗口合并与 `firstAt`/`lastAt`、自定义窗口拆分、无时间 entry 合并 |
| 脱敏与截断 | 6 | 240 码点截断、密码赋值、`sk-`/`ghp_`/`AKIA`、Bearer、posix/Windows home 路径、ANSI/控制字符 |
| 上限与排序 | 2 | `MAX_EVIDENCE`/`limit` 与 `groups`、severity/count 排序与证据形状（不含 `raw`） |
| 健壮性与安全红线 | 3 | 空/非法输入不抛异常、source 归一、源码纯度（无 import/require/child_process/node:fs 等） |

## 安全红线（测试锁死）

- 模块**零 import、零第三方依赖**，不读文件、不建连接、不执行命令、不拼接命令、不启动进程；
- `evidence[]` 只保存脱敏并截断后的摘要，**绝不携带 `entry.raw` 整行原文**；
- 脱敏先于入库：密钥、令牌、Bearer 凭据、本机 home 目录前缀一律替换为 `[redacted]`；
- 对无法识别的内容保留 message、`at = null`，category **宁可归 `unknown` 也不猜**故障类别；
- 测试用例直接读取模块源码，断言不存在 `import` / `require(` / `child_process` / `node:fs` 等 I/O 或进程 API。

## 遗留与接线

### 真实日志读取

- 本期不读取真实日志。`apps/fnos-nas-agent/app/log-tail-collector.mjs` 已提供受限读尾能力：
  - `createLogTailCollector({ paths = DEFAULT_LOG_PATHS, maxBytes = MAX_LOG_BYTES, fs })`；
  - `DEFAULT_LOG_PATHS = ["/var/log/syslog", "/var/log/messages", "/var/log/kern.log"]`；
  - `MAX_LOG_BYTES = 64 * 1024`；返回 `{ text, notes, sources }`。
- 接线方式：采集器把 `text` 与来源名交给调用方 → `parseLogLines(text, { source })` → `buildLogEvidence(entries)`；模块本身保持纯函数。

### 接入 `diagnostic-evidence.mjs`

| 位置 | 改动 |
| --- | --- |
| `apps/fnos-nas-agent/app/diagnostic-evidence.mjs:19` | `DIAGNOSTIC_EVIDENCE_SOURCES` 增加 `"log"` |
| 同文件 `collectDiagnosticEvidence()`（约 L309） | 入参增加 `logEntries = []` |
| 同文件 perSource 装配处（约 L319–L336） | 增加 `perSource.set("log", mapSource(logEntries, ...))`，`mapSource` 回调里调用 `buildLogEvidence(logEntries)` |
| 同文件 `buildEvidenceBundle()`（约 L400） | 目前 `evidence` 只保留 `{ source, detail }`；若要把 `category/severity/count/firstAt/lastAt` 带进 bundle，需扩展该白名单（否则新字段会被丢弃） |

分类映射建议（把 7 类日志分类映射到诊断分类白名单 `storage|network|resource|permission|application`）：

| 日志 category | 诊断分类 |
| --- | --- |
| `io-error`、`disk` | `storage` |
| `oom` | `resource` |
| `network` | `network` |
| `permission` | `permission` |
| `service`、`unknown` | `application` |

### 尚未覆盖

- **SMART 数据仍未接入**（D02 的剩余部分，属于存储证据源，与本模块无直接耦合）；
- kernel 事件目前只能通过 `source: "kernel"` 标记，真实内核日志来源与优先级需要 Lead 决定；
- 跨来源去重（同一故障同时出现在 syslog 与 docker）尚未实现；
- RFC 3164 没有年份，本模块坚持原样保留文本，不做跨年/时区推断；需要时间线的调用方需自行补年份；
- 真实日志读取与 `diagnostic-evidence.mjs` 的接线由 `log-tail-collector` 与 Lead 负责，本期不接。

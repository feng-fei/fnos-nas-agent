# Phase 194 — 系统事件解析与聚合（纯函数）

## 背景

NAS 现场的排障信息通常散落在三类日志里：

- 内核日志：`/dev/kmsg` / `dmesg` 输出的 `<N>` 优先级前缀（或 `kern.err:` 设施前缀）；
- systemd 日志：`journalctl -o short` 风格的 `Oct 24 01:02:03 host unit[pid]: msg`；
- 应用/脚本文本日志：直接以 `LEVEL: msg` 开头，或完全不带级别。

如果让上层（Agent、CLI、告警）自己去 grep 和猜日志格式，很容易把「没有日期」误读成「今天」，把未知级别当成 `info`，或者把同一条反复刷屏的错误重复上报。本阶段把「文本 → 结构化事件 → 结论/重复分组」沉淀成一个可单测的纯函数层：

- 不做任何 I/O：不读文件、不执行 `dmesg`、不连 journald，也不 import 任何模块；
- 不解释「时间」：拿不到墙钟时间就返回 `null`，绝不补当前时间；
- 不猜级别：无法识别的记号归 `notice` 并记账，而不是猜测；
- 失败可对账：无法识别的行进入 `dropped`，同时写进 `notes`，数字必须和输入行数对得上。

本模块只负责「把调用方已经拿到的日志文本算清楚」，采集与权限策略留在上层。

## 导出 API 与字段

模块路径：`apps/fnos-nas-agent/app/system-events.mjs`（ESM，零依赖，零 I/O）。

### 常量

| 导出 | 值 | 说明 |
| --- | --- | --- |
| `EVENT_LEVELS` | `["emerg","alert","crit","err","warning","notice","info","debug"]` | syslog 八级 severity，从最严重到最不严重；已 `Object.freeze` |
| `MAX_MESSAGE_LENGTH` | `240` | 单条 message 的最大码点数，解析与 `firstSample` 共用 |
| `DEFAULT_REPEAT_LIMIT` | `20` | `summarizeEvents` 的默认 `limit` |

### `parseLogLines(text)`

把整段日志文本逐行解析成事件。

```js
parseLogLines(text) -> {
  events: [{ level, source, timestamp, message }],
  dropped: number,
  notes: string[]
}
```

事件对象的字段固定为四个键（顺序也固定）：

| 字段 | 类型 | 取值 |
| --- | --- | --- |
| `level` | `string` | 八级之一；别名归一，未知归 `notice` |
| `source` | `string` | kmsg → `"kernel"`；`facility.level` → 设施名小写（如 `"kern"`）；journal 行 → 单元名（去掉 `[pid]`，如 `"sshd"`）；纯级别行 → `"log"` |
| `timestamp` | `string \| null` | 只有 journal 短格式有：`"Mon DD HH:MM:SS"`（单空格、日不补零、不含年份）；其余格式一律 `null` |
| `message` | `string` | 去掉格式前缀后的正文；控制字符归一为空格、两端 trim、按码点截断到 240；格式前缀后本身为空时保留空字符串，不伪造内容 |

识别的格式按以下顺序尝试：

1. **kmsg**：`<N>message`，`N` 为 0–191 的 PRI 值。`0–7` 直接映射到 `EVENT_LEVELS[N]`；`8–191` 按 `N & 7` 取 severity（同时记 `pri-decoded`）；`> 191` 视为未知，归 `notice`。正文开头若还有 `[ 1234.567890]` 形式的单调时钟，会被剥掉。
2. **设施前缀**：`facility.level: message`，如 `kern.err: eth0: link down`。`facility` 只做小写保留，`level` 支持 syslog 名字与常见别名（见下）。
3. **journalctl short**：`Mon DD HH:MM:SS host unit[pid]: message`。月份必须是 `Jan..Dec`；`DD` 可一位或两位；`unit` 不含空白、`[`、`]`、`:`；`[pid]` 可省略。命中后级别固定为 `notice`（原因见「不猜原则」）。
4. **纯级别**：`LEVEL: message`，`LEVEL` 可含字母、数字、`_`、`-`、`.`。
5. 以上都不命中 → `dropped += 1`，不伪造事件。

别名归一见下表（大小写不敏感）：

| 输入记号 | 归一结果 |
| --- | --- |
| `emergency`, `panic` | `emerg` |
| `alert` | `alert` |
| `critical`, `fatal` | `crit` |
| `error`, `err` | `err` |
| `warn`, `warning` | `warning` |
| `notice` | `notice` |
| `info`, `information`, `informational` | `info` |
| `debug`, `trace` | `debug` |
| 其他 | `notice`（并记 `unknown-level`） |

`notes` 是给调用方/上层 Agent 看的对账信息，只包含非零项，顺序稳定：

| note 文本 | 触发条件 |
| --- | --- |
| `dropped: N unrecognized line(s)` | 有 N 行无法识别（等于 `dropped`） |
| `unknown-level: N line(s) mapped to notice` | 有 N 行的级别记号未知，被归为 `notice` |
| `journalctl-priority-missing: N line(s) mapped to notice` | 有 N 行 journal 短格式，缺少优先级字段 |
| `pri-decoded: N line(s)` | 有 N 行 kmsg 使用 facility 编码的 PRI（> 7），按低 3 位解码 |
| `truncated: N message(s)` | 有 N 条 message 超过 240 码点被截断 |

非字符串输入（含 `null`、`undefined`、数字、对象）返回空结果并附一条
`invalid-input: expected log text`；纯空字符串返回
`{ events: [], dropped: 0, notes: [] }`，不视为错误。

### `normalizeEventMessage(message)`

把一条事件正文归一成「聚合分组键」：

```js
normalizeEventMessage(message) -> string
```

处理顺序：控制字符 → 空格 → 转小写 → 替换占位符 → 压缩空白并 trim。

| 片段 | 占位符 | 说明 |
| --- | --- | --- |
| 路径片段，如 `/var/log/app.log` | `<path>` | 以 `/` 开头、由路径字符组成的片段；要求前一个字符不是单词字符或 `.`，避免把 `192.168.1.5/24` 误切 |
| UUID，如 `5c1f2a9e-3b4d-4f6a-9c8e-2d1b0a9f8e7d` | `<uuid>` | 标准 8-4-4-4-12 形式 |
| 十六进制，如 `0xDEADBEEF` | `<hex>` | 以「非单词字符 + 0x + 十六进制数字」匹配，不切词内数字 |
| 数字，如 `4321`、`3.14` | `<num>` | 可带一个小数点；IP/端口因此近似归一（见遗留） |

顺序上先路径、再 UUID、再十六进制、最后普通数字，避免 `/dev/0x1f` 被拆成 `<path><hex>` 这种不完整占位符。非字符串或仅空白的输入返回 `""`。空字符串返回 `""`，调用方需自行决定是否丢弃。

### `summarizeEvents(events, options = {})`

```js
summarizeEvents(events, { limit = 20 } = {}) -> {
  verdict: "ok" | "warning" | "critical" | "unknown",
  counts: { emerg, alert, crit, err, warning, notice, info, debug },
  repeated: [{ normalized, count, firstSample, level }],
  notes: string[]
}
```

- `events` 可以是事件数组，也可以是 `{ events: [...] }`（可直接接收 `parseLogLines` 的结果）；其他输入抛 `TypeError`。
- `counts` 永远包含八个级别键，未出现的补 0。
- 无有效事件时 `verdict` 为 `"unknown"`（**不是** `"ok"`）。
- `verdict` 判定顺序：`counts.emerg + counts.alert + counts.crit > 0` → `"critical"`；否则 `counts.err > 0` → `"warning"`；否则 `"ok"`。
- 事件缺少 `level` 或级别无法识别时不计数、不分组，记入 `invalid-event`；`message` 为空（含全是空白）时计入 `empty-message`，不进入 `repeated`（没有可分组的文本）。
- `repeated` 的分组键是 `normalizeEventMessage(message)`；组内字段：
  - `normalized`：分组键；
  - `count`：出现次数；
  - `firstSample`：**首次出现那条事件的原始 message**（保留大小写，仅控制字符转空格 + trim，按码点截断 240）；
  - `level`：首次出现那条事件的级别（后续同组的更严重级别不会改写它，见遗留）。
- 排序：`count` 降序；`count` 相同按首次出现顺序升序。截断到 `limit`，被省略的组数写进 `repeated-truncated` note。
- `limit` 必须是正整数（`Number.isInteger(limit) && limit > 0`）。`0`、负数、小数、字符串、`null`、`NaN`、`Infinity` 一律抛 `TypeError`；`options` 本身为 `null` 也抛 `TypeError`。默认值 20。
- `notes` 只会包含：`no-events`、`no-valid-events`、`invalid-event: N event(s) ignored`、`empty-message: N event(s) skipped`、`sample-truncated: N first sample(s)`、`repeated-truncated: N group(s) omitted`（均只在非零时出现）。

## 语义与安全边界（含「不猜」原则）

### 「不猜」原则

1. **不猜时间**：kmsg 的 `[ 1234.567890]` 是单调时钟，不是墙钟；`journalctl short` 不带年份；纯文本行没有日期。这些场景 `timestamp` 一律 `null`，不补 `now()`、不补年份、不把 monotonic 当秒数换算。
2. **不猜级别**：journal 短格式没有 priority 字段，统一按 `notice` 处理并写 `journalctl-priority-missing` note；级别记号无法识别时按 `notice` 处理并写 `unknown-level` note。把 `error` 降级成 `notice` 会让故障被 `verdict` 判成 `ok`，所以 `error` 明确归一为 `err`。
3. **不猜结构**：不匹配的行只进入 `dropped` 和 `notes`，绝不拼凑出「猜测的事件」；多行堆栈的第二行起也会被丢弃（见遗留）。
4. **不猜来源**：`source` 只来自日志里真实出现的字段（`kernel`、设施名、单元名、`log`），不从正文内容反推进程。

### 安全边界

- 模块**无 I/O**：不 import 任何模块，不引用 `node:fs`、`node:child_process`、`node:http`、`node:net`、`node:dns`、`node:os`、`node:path`，不读环境变量、不执行命令、不发网络请求。测试里有一条静态断言专门守这个边界。
- 输入必须是调用方已经取得的文本；采集权限、`dmesg` 是否可读、journald 是否可访问，都由上层决定，本模块不尝试提权。
- 纯函数：相同输入得到相同输出，不依赖时间、随机数、全局状态；`EVENT_LEVELS` 只读。
- 控制字符（`U+0000–U+001F`、`U+007F`）统一归一为空格，避免日志里的 `\r`、`\t`、`\0`、ANSI 转义前导（`\x1b`）破坏下游展示或分组。
- 单条消息截断到 240 个 Unicode 码点（用 `Array.from`，不会把代理对切成半个字符），防止一条超长内核日志撑爆上层上下文。
- `firstSample` 保留原始细节（仅截断），可能包含路径、IP、主机名等现场信息；对外展示前应按上层的数据分级策略处理，不要直接回显到不可信通道。
- 输入规模没有内置上限：`parseLogLines` 需要把整段文本和全部事件放进内存，`summarizeEvents` 的分组表大小与「归一后不同消息数」成正比。超大日志（数百 MB）应由调用方分段传入，本模块不做流式处理。

### 对账公式

`parseLogLines` 以 `\n` 切分文本（CRLF 的 `\r` 由控制字符归一处理），于是：

```
text.split("\n").length === events.length + dropped + blanks
```

其中 `blanks` 是 trim 后为空的行数；空行只跳过，**不计入** `dropped`。`notes` 里的 `dropped: N` 与返回的 `dropped` 永远一致。这条公式由测试 `parseLogLines skips blank lines and reconciles dropped with the notes` 直接断言。

## 测试结果

测试文件：`tests/phase-194-system-events.test.mjs`（`node:test` + `node:assert/strict`，24 个用例）。

```text
$ node --check apps/fnos-nas-agent/app/system-events.mjs
$ node --check tests/phase-194-system-events.test.mjs
$ node --test tests/phase-194-system-events.test.mjs
# tests 24
# pass 24
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

环境：Windows + Node v22.22.0。

覆盖点：

- 常量与八级顺序、事件对象字段严格为 `{level,source,timestamp,message}`；
- kmsg：八级前缀、facility 编码 PRI（`38→info`、`35→err`、`999→notice`）、单调时钟剥离、`timestamp === null`；
- `facility.level`、journalctl short（`sshd[4321]`、日期单空格化、无 pid 单元、缺优先级 → `notice` note）；
- 纯级别行、常见别名（`ERROR`/`WARN`/`fatal`/`trace`）、未知级别 → `notice`；
- 控制字符归一、240 码点截断、空行跳过、`dropped` 与 note 数字对账、非字符串输入的 `invalid-input`；
- `normalizeEventMessage`：路径/UUID/十六进制/数字占位符、大小写与空白压缩、不同 IP/端口的同一事件归为一组、非字符串返回 `""`；
- `summarizeEvents`：空输入 `verdict === "unknown"`、`err → warning`、`crit/alert/emerg → critical`、仅 `notice/info/debug → ok`；
- `repeated` 按 count 降序、平局按首次出现顺序、`firstSample` 取原始首条并按 240 截断、`level` 取首条；
- `limit` 的 8 种非法值全部抛 `TypeError`，合法 limit 与默认 20 的截断 note；
- 非事件输入抛 `TypeError`、未知级别事件被忽略并记 `invalid-event`；
- 端到端：`parseLogLines` → `summarizeEvents`（两条 `/dev/sda*` 的 EXT4 错误归为 `ext4-fs error on <path> at <hex>`）；
- 静态边界：源码不含 `import`、`require(`、`node:fs`、`node:child_process`、`node:http`、`node:net`、`node:dns`、`node:os`、`node:path`，且不含 `execSync`/`spawnSync` 等调用。

## 遗留

1. **文档索引未登记**：本阶段只允许新增 3 个文件，因此没有修改 `docs/README.md`。仓库的 `tests/docs-links.test.mjs:59` 会断言 `docs/README.md` 列出 `docs/` 下的每个文档，所以在索引补齐之前，跑全量 `node --test` 会因为这个新文档而失败（Phase 190 也留下了同样的处理）。后续需要单独一次变更，在 `docs/README.md` 的文档表里加上 `phase-194-system-events.md`。
2. **journalctl short 的精度损失**：短格式没有优先级和 PID，当前 PID 被丢弃、级别固定为 `notice`。如果后续需要更准确的级别，应在采集层改用 `journalctl -o json` 或 `-o verbose`，由新格式解析器处理，而不是在纯文本层猜。
3. **kmsg 的 facility 位被丢弃**：`source` 固定为 `"kernel"`，`pri-decoded` 只保留在 note 里。若上层要区分 `kern` / `user` / `daemon` 等设施，需要把 `PRI >> 3` 解码成设施名后扩展事件字段（会改变事件字段契约，需评估）。
4. **时间语义只做保留、不做换算**：`timestamp` 是原样字符串（无年份、无时区），不能直接用于排序或计算时间差。需要绝对时间时应由采集层补 `__REALTIME_TIMESTAMP`，本阶段不猜。
5. **多行日志没有续行合并**：Java 堆栈、`systemd` 的多行单元输出，第二行起可能被 `dropped`。后续可增加「缩进/无格式前缀行归并到上一条」的可选策略，但要先定义 `dropped` 对账方式。
6. **`firstSample` 可能携带敏感现场信息**：它保留原始 message（截断到 240），路径、IP、主机名都在。展示层需要按数据分级处理。
7. **IPv4 分组是近似的**：`192.168.1.5:22` 与 `10.0.0.9:2222` 都归一为 `<num>.<num>:<num>`，这对「同一类连接失败」是正确的聚合，但会丢失「哪个地址」的信息；需要区分时请用 `firstSample`，不要用 `normalized`。
8. **没有流式/增量接口**：每次调用都要整段文本；大日志需要上层分页。若后续要做「持续 tail」，建议在采集层做窗口切片，再复用本模块。
9. **verdict 阈值写死**：`err → warning`、`crit/alert/emerg → critical` 是固定规则，没有可配置阈值；本阶段不做策略化，等有真实告警需求再加参数。
10. **`summarizeEvents` 的组级别取首条**：同一归一化消息如果首次是 `warning`、后续出现 `crit`，组的 `level` 仍是 `warning`（但 `counts`/`verdict` 会正确判 `critical`）。这是为了让 `repeated` 讲「第一次长什么样」；若上层需要「组内最高级别」，需要扩展字段，不能改现有语义。

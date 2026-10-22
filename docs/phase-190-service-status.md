# Phase 190 — 服务状态：校验 / 解析 / 结论层

能力矩阵 **S10（服务状态）** 与 **C03（查询服务状态）** 此前仍是 Open。本阶段交付的是
「拿到 `systemctl show <unit>` 输出之后怎么判」的那一层：unit 名校验、Key=Value 解析、
结论判定、汇总，以及一个**由外部注入采集器**的采集入口。

本阶段**不执行任何命令、不内置任何 fnOS unit 名单、不做 I/O**。真正的采集器（nsenter /
只读白名单）由 Lead 后续注入，注入点就是 `collectServiceStatus({ units, run })` 的 `run`。

- 模块：`apps/fnos-nas-agent/app/service-status.mjs`（ESM，零依赖，零 `import`）
- 测试：`tests/phase-190-service-status.test.mjs`（node:test，29 个用例）
- 自验：`node --check apps/fnos-nas-agent/app/service-status.mjs`、
  `node --check tests/phase-190-service-status.test.mjs`、
  `node --test tests/phase-190-service-status.test.mjs`

---

## 1. 为什么需要单独一层

真机采集到手的是这样一段文本：

```
LoadState=loaded
ActiveState=active
SubState=running
UnitFileState=enabled
MainPID=1234
MemoryCurrent=18446744073709551615
NRestarts=0
Result=success
```

这段文本里至少有三个坑：

1. `MemoryCurrent=18446744073709551615` 是 systemd 的「无限制」哨兵值，直接 `Number()` 会得到
   一个巨大的数，报给用户等于撒谎；它必须变成 `null`。
2. `UnitFileState=[not set]`、`NRestarts=` 这类值代表「没有值」，不是字符串 `"[not set]"`。
3. `ActiveState=active` 并不等于「在跑」：`SubState=start`（启动中）也是 active。任何
   「默认当作 running」的写法都会在服务起不来的时候给出最错误的结论。

所以本层把「字符串 → 结构化字段 → 结论」拆成三个纯函数，外加一个汇总函数和一个注入式采集器，
全部可单测、可离线验证。

## 2. API 与字段

### `validateUnitName(name)` → `{ ok, reason }`

- 合法形状：`^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.(service|timer|socket|mount)$`，长度 ≤ 256。
- 合法：`{ ok: true, reason: null }`。
- 不合法：`{ ok: false, reason }`，`reason` ∈ `empty`、`too-long`、`bad-suffix`、
  `forbidden-char`、`bad-shape`。
- 判定顺序：`empty` → `too-long` → `forbidden-char` → `bad-suffix` → `bad-shape`。
  先判危险字符、再判形状，是为了让审计日志能区分「注入尝试」和「拼写错误」。
- `forbidden-char` 覆盖空白（含 `\t`/`\n`）、`/`、反引号、`$`、`;`、`|`、`&`、`>`、`<`、
  反斜杠、单双引号、`*`、`?`、括号、花括号、`#`、`!`、`=`、`+`、`,`、`~`、`^`、`%`、`/`
  以及全部控制字符。命中即拒，不做任何「清洗后放行」。
- `null` / `undefined` → `empty`；其他非字符串（数字、对象）→ `bad-shape`；
  纯空白字符串 → `empty`。

### `parseSystemctlShow(text)` → 八个契约字段 + `parsed`

返回 `{ loadState, activeState, subState, unitFileState, mainPID, memoryCurrentBytes,
restartCount, result, parsed }`，分别对应 `LoadState`、`ActiveState`、`SubState`、
`UnitFileState`、`MainPID`、`MemoryCurrent`、`NRestarts`、`Result`。

- 只取这八个键，其他行（如 `Description`）忽略；同一个键重复出现时**后者为准**。
- `[not set]`（大小写不敏感）与空值统一为 `null`。
- 数值字段只接受十进制非负整数（`/^\d+$/`）且必须落在 `Number.isSafeInteger` 范围内：
  `-1`、`1.5`、`0x10`、`abc`、超出安全整数的值一律 `null`。
- `MemoryCurrent=18446744073709551615` 显式按哨兵值处理为 `null`；
  相邻的 `18446744073709551614` 也会因为超出安全整数范围变成 `null`。
- 输入非字符串或空白 → 八个字段全 `null`、`parsed: false`。
- `parsed` 的语义是「至少解析出一个 `Key=Value` 行」：非空但没有 `=` 行的文本
  （例如 `systemctl: unit not found`）也是全 `null` + `parsed: false`，不谎报成功。

### `describeServiceVerdict(record)` → `"running" | "stopped" | "failed" | "unknown"`

- `running`：`activeState === "active"` 且 `subState` ∈ `running|exited|listening`。
- `failed`：`activeState === "failed"` 或 `result === "failed"`。
- `stopped`：`activeState` ∈ `inactive|dead`。
- 其余（缺字段、`unknown`、`activating`/`deactivating`/`reloading` 等过渡态、`null`、
  非对象）→ `unknown`。**绝不默认 running。**

### `summarizeServices(records)` → `{ counts, items, verdict, notes }`

- `counts`：`{ running, stopped, failed, unknown }` 计数。
- `items`：`[{ id, unit, verdict, activeState, subState }]`；`id` 优先取记录的 `id`，
  否则取 `unit`，再否则 `record-<序号>`。
- `verdict`：有 `failed` → `degraded`；全部 `unknown`（含空列表）→ `unknown`；否则 `healthy`。
- `notes` 是字符串数组，按以下顺序拼装：
  - `no-services`（空列表）；
  - `failed: <ids>`；
  - `unknown-verdict: <ids>`；
  - `missing-unit: <ids>`（记录没有 `unit`）；
  - `<采集备注>: <ids>`（`no-collector` / `collector-failed` / `invalid-unit` / `invalid-output`）。
- 非数组入参抛 `TypeError`；数组里的 `null` 条目按「缺字段」处理，不抛错。

### `collectServiceStatus({ units, run })` → `{ collectedAt, items, summary }`

- `run` 是注入的 `async (unit) => rawText`；不注入或非函数时，每条 `verdict: "unknown"`、
  `note: "no-collector"`——**没有采集器就说不知道，绝不假装 running**。
- 逐条**串行**采集，保持输入顺序。
- 单个 unit 抛错只影响该条：`note: "collector-failed"`，`error` 为错误信息
  截断到 200 字符，其余条目不受影响。
- unit 名不合法：不调用采集器，仍保留一条 `verdict: "unknown"`、`note: "invalid-unit"`、
  带 `reason` 的条目（跳过的是采集动作，不是可见性）。
- 采集器返回的文本解析不出任何字段：`note: "invalid-output"`，结论 `unknown`。
- `units` 必须是数组且 ≤ 64 条，否则抛 `RangeError`（非数组、超过 64、缺省入参都抛）。
- `collectedAt` 是 `new Date().toISOString()` 的 ISO-8601 字符串。

导出的常量：`UNIT_SUFFIXES`、`MAX_UNIT_NAME_LENGTH`（256）、`MAX_UNITS`（64）、
`MAX_ERROR_MESSAGE_LENGTH`（200）、`UNIT_NAME_PATTERN`、`INVALID_UNIT_REASONS`、
`VERDICTS`、`COLLECT_NOTES`、`RUNNING_SUB_STATES`、`STOPPED_ACTIVE_STATES`、
`MEMORY_UNLIMITED_SENTINEL`。

## 3. 为什么不内置 fnOS unit 名单

- **不知道就不要编。** 仓库里没有一条经过真机验证的 fnOS unit 清单；凭印象写死
  `trim.service`、`fnos-xxx.service` 之类的名字，只会在真机上采到一片 `unknown`，
  然后把「不存在」误报成「未运行」。
- **名单会漂移。** fnOS 版本升级会增删 unit（FPK、影视、相册、备份都会带自己的服务），
  写死的名单必然过期，且过期时没有任何信号。
- **越权风险。** 一旦内置名单，后续很容易演变成「先去 ps/读 /etc/systemd 找 unit」，
  这就越过只读白名单了。本层只接受**调用方传入的** unit 名，越权面为零。
- **契约先行。** 本层是纯函数，任何人拿真实名单或一条假文本都能立即验证结论是否正确；
  名单属于接线阶段（Lead 的采集器）的运行时数据，不属于解析层。

## 4. 安全边界

- **只解析，不执行。** 模块没有任何 `import`，测试里有一条用例静态断言源码不含
  `import` / `require(` / `node:fs` / `node:child_process` / `node:http` / `node:net` /
  `node:dns` / `node:os` / `node:path`。
- **不碰 systemd、不碰 shell。** 不存在 `exec`、`spawn`、模板拼接命令行；unit 名只用于
  与注入的 `run` 通信，而 `run` 由 Lead 实现并负责自己的白名单。
- **输入即不可信。** unit 名在进入采集前先校验，含 shell 元字符或路径穿越的输入在
  `validateUnitName` 就被拒绝（`forbidden-char`），不会到达采集器。
- **失败不升级成运行。** 缺字段、过渡态、采集器缺失、采集器报错、输出不可解析，一律
  `unknown`，并在 `notes` 里留痕。
- **有界。** 单次最多 64 个 unit，unit 名最长 256，错误信息截断 200 字符，避免把
  真机输出或堆栈原样塞进上下文。

## 5. 测试

`node --test tests/phase-190-service-status.test.mjs`：**29 tests / 29 pass / 0 fail**
（Node v22.22.0，本机 Windows 执行，无真机、无网络调用）。

覆盖点：

- unit 名：四种后缀的合法样例、`@`/`:` 合法字符、空/null/undefined/纯空白、
  256 与 257 的长度边界、错误后缀、大小写后缀、路径穿越与 shell 元字符（14 个样例）、
  错误形状、非字符串标量；
- 解析：全字段映射、CRLF、`[not set]` 与空值、`MemoryCurrent` 哨兵值、
  不安全整数/负数/非数字、`0` 的合法性、非字符串与空输入、无 `Key=Value` 文本、
  重复键后者为准、未知键忽略；
- 结论：`active` × `running|exited|listening` → running，`active` × `start` → unknown，
  `failed` 状态与 `Result=failed`、`inactive`/`dead` → stopped，过渡态 → unknown，
  `null`/`{}`/缺字段 → unknown；
- 汇总：空列表、有 failed → degraded、全 unknown → unknown、running+stopped → healthy、
  混合 unknown 时 healthy 但 notes 留痕、非数组抛 `TypeError`、`null` 条目容错；
- 采集：无 collector 全 unknown、正常采集出 running/stopped 与 healthy、
  单条抛错隔离且错误信息截断 200、非法 unit 不调用采集器、不可解析输出、
  非函数 `run`、64 条边界通过 / 65 条与非数组抛 `RangeError`、空列表、
  `collectedAt` 为 ISO 字符串。

## 6. 语义取舍

- **running 优先于 failed。** 契约把 running 判定写在前面，因此
  `activeState=active + subState=running + result=failed` 判为 running。
  如果后续希望「有失败结果就报失败」，只需把 `describeServiceVerdict` 里 failed 分支
  移到 running 之前，测试相应调整。
- **stopped 只认 `inactive` / `dead`。** 契约里「明确非 active → stopped」一句也可以读成
  「`activating` 也算 stopped」，但那样会在服务刚启动时就报「已停止」。本层选择把过渡态
  （`activating`/`deactivating`/`reloading`/`maintenance`）归为 `unknown`：不知道就说不确定。
- **混合 unknown 仍然 healthy。** 契约只规定「有 failed → degraded、全部 unknown → unknown、
  其余 healthy」，所以「2 running + 1 unknown」是 healthy。为了保证这种 healthy 不是静默的，
  每条未知/失败原因都会写进 `notes`（`unknown-verdict:`、`collector-failed:`、
  `invalid-output:`、`invalid-unit:`、`no-collector:`）。若 Lead 希望把采集失败升级为
  `degraded`，只需在 `summarizeServices` 的 verdict 判定里加一行。
- **非法 unit 仍然出现在 items 里。** 契约写「直接跳过并记 note」，本层跳过的是采集调用，
  条目保留（`verdict: "unknown"`、`note: "invalid-unit"`、带 `reason`），
  否则调用方看不到自己传错了什么。
- **非法 unit 优先于缺采集器。** 两者同时成立时记 `invalid-unit`，因为那更需要修。
- **`parsed` 表示「解析出了字段」而不是「输入非空」**，这样无 `Key=Value` 的文本不会被
  当成成功解析。
- **不 trim unit 名、不补后缀。** 带前后空白的输入直接 `forbidden-char` 拒绝，
  `trim-service` 也不会被自动补成 `trim-service.service`：本层不做任何猜测。

## 7. 遗留 / 接线清单

1. **采集器由 Lead 注入。** `collectServiceStatus({ units, run })` 需要真正的
   `run`：按只读白名单 + nsenter 执行 `systemctl show <unit>` 并返回 stdout 文本。
   建议在该层做超时、并发上限与输出大小上限（本层只限制条数与错误信息长度）。
2. **真机 unit 名单由 Lead 决定。** 本层刻意不带名单；首批候选需要真机验证后再写进采集器，
   并考虑名单随 fnOS 版本变化的来源。
3. **docs 索引未登记（本阶段限制）。** 任务约束「只允许新建三个文件」，因此没有把本文档加进
   `docs/README.md`。仓库既有的 `tests/docs-links.test.mjs` 要求
   「docs/README.md lists every document in docs/」，所以**全量 `node --test` 会因此失败**；
   接线时需要向 `docs/README.md` 补一条 `phase-190-service-status.md` 链接。
4. **HTTP / UI 接线未做。** 本阶段不新增路由、不新增工具注册；是否把 `summary` 暴露成
   `overview` 的一个区块由后续阶段决定。
5. **`Result` 与 `ActiveState` 冲突时的语义**（见第 6 节）如需调整，改一处分支即可，
   不涉及调用方契约。

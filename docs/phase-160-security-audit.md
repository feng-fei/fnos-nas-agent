# Phase 160 — 安全巡检与审计报告

本阶段把用户功能清单里**模块 08「安全审计与权限控制」**的 SEC03、SEC17、
SEC18 三项，以及**模块 16** 的 O06（错误聚合），实现为一个**不依赖任何 I/O
的纯函数模块** `apps/fnos-nas-agent/app/security-audit.mjs`。

模块本身不读审计文件、不碰文件系统、不连模型：所有结论都来自调用方传入
的快照数据。没有数据时它报告「未发现问题」，而不是臆造一条结论。

本阶段**不修改**任何既有文件：`app/audit-log.mjs`、`app/tool-registry.mjs`、
`app/execution-policy.mjs`、`app/permission-policy.mjs`、`app/server.mjs`
与全部前端文件保持原样，模块的挂载由后续集成步骤完成。

## 1. 背景：四个编号对应的需求

| 编号 | 需求 | 本阶段对应实现 |
| --- | --- | --- |
| SEC03 | 工具权限表：每个工具的来源、风险级别、是否需要一次性确认 | `buildToolPermissionTable()` |
| SEC17 | 安全巡检：对当前部署做一次面面俱到的检查并给出结论 | `runSecurityInspection()` |
| SEC18 | 审计报告：把审计记录归纳成可读的结论 | `summarizeAuditEntries()` |
| O06 | 错误聚合：把重复出现的错误归并成一条模式 | `summarizeAuditEntries().repeatedErrors` |

既有模块提供原料，本阶段不复制它们的判定逻辑：

- `app/audit-log.mjs:38-49` 的 `normalizeEvent()` 决定一条审计记录的形状：
  `at / method / route / statusCode / outcome`，外加 `sessionId / toolId /
  target / risk / requestId` 五个可选字段（`audit-log.mjs:18`）；`outcome`
  由状态码推导（`:43`）。
- `app/tool-registry.mjs:73-89` 的 `normalizeTool()` 决定一个工具的形状：
  `id / title / description / risk / inputSchema / source`，`source` 形如
  `{id, kind, label}`，`risk` 只取 `read-only | write | destructive`。
- `app/execution-policy.mjs:78-92` 是**唯一**的执行判定点：只读与写工具直接
  放行，破坏性工具在没有 `approved === true` 时返回
  `{allowed:false, requiresApproval:true, reason:"approval-required"}`。
- `app/permission-policy.mjs:29-45` 是旧风险词表的包装层，判定同样收敛到
  执行策略。

本阶段只在**报告层**描述这些判定，不重新实现它们。

## 2. 变更边界

本阶段**只新增**三个文件：

| 文件 | 作用 |
| --- | --- |
| `apps/fnos-nas-agent/app/security-audit.mjs` | ES module，导出 5 个纯函数 + 2 个常量；无 I/O、无第三方依赖 |
| `tests/phase-160-security-audit.test.mjs` | `node --test` 用例 |
| `docs/phase-160-security-audit.md` | 本文档 |

明确**没有**发生的事：

- 没有修改 `app/audit-log.mjs`、`app/tool-registry.mjs`、
  `app/execution-policy.mjs`、`app/permission-policy.mjs`；
- 没有修改 `app/server.mjs`，没有新增、修改或删除任何 HTTP 路由；
- 没有修改 `app/ui/` 下的任何文件；
- 没有修改 `README.md`、`docs/README.md`、`scripts/check-release-gates.mjs`；
- 没有执行 `git commit` / `git push`。

模块不读取审计文件，也不写入任何文件：审计记录的读取方式（`audit.jsonl`、
`audit.jsonl.1` 轮转、0600 权限，见 `audit-log.mjs:52-96`）完全属于调用方。

## 3. 导出 API 约定

```js
import {
  summarizeAuditEntries,
  buildToolPermissionTable,
  runSecurityInspection,
  maskSecret,
  normalizeErrorMessage,
  SECURITY_AUDIT_SECTION_IDS,
  SEVERITY_LEVELS
} from "./security-audit.mjs";
```

| 导出 | 签名 | 返回 | 说明 |
| --- | --- | --- | --- |
| `summarizeAuditEntries` | `(entries: Array<object>, options?: {limit?: number}) => object` | `{total, byAction, byOutcome, repeatedErrors, recentFailures}` | 审计报告（SEC18）+ 错误聚合（O06） |
| `buildToolPermissionTable` | `(catalog: Array<object> \| {tools: Array<object>}, options?: {approvalRequired?: Array<string>}) => Array<object>` | `[{tool, source, risk, requiresApproval, description}]` | 工具权限表（SEC03） |
| `runSecurityInspection` | `(input?: {toolCatalog?, auditEntries?, config?, scheduledChecks?, storageRoots?}) => object` | `{generatedAt, sections, summary}` | 安全巡检（SEC17） |
| `maskSecret` | `(value: unknown) => string` | 掩码后的字符串 | 只保留前 2 位，其余固定 8 个 `*` |
| `normalizeErrorMessage` | `(value: unknown) => string` | 归一化后的消息 | 去掉数字、时间戳、引号内容、UUID 后返回；无可用字符时返回 `""` |
| `SECURITY_AUDIT_SECTION_IDS` | `readonly string[]` | 6 个巡检项 id | 顺序即报告顺序 |
| `SEVERITY_LEVELS` | `readonly string[]` | `["critical","warning","info"]` | 严重级别词表 |

### 3.1 `summarizeAuditEntries`

| 字段 | 形状 | 说明 |
| --- | --- | --- |
| `total` | `number` | 参与统计的记录条数 |
| `byAction` | `Record<string, number>` | 按 action 计数；action 取 `entry.action`，回退到 `entry.route`，再回退到 `entry.method` |
| `byOutcome` | `Record<string, number>` | 按 outcome 计数；缺失时由 `statusCode` 推导（`<400` 成功，`<500` 拒绝，其余错误） |
| `repeatedErrors` | `Array<{message, count}>` | 只保留 `count >= 2` 的组，按 `count` 降序、同数按消息字典序，取前 `limit` 条 |
| `recentFailures` | `Array<{at, action, outcome, detail}>` | 非 success 的记录，按 `at` 降序，取前 `limit` 条（上限 50） |

消息归一化（`normalizeErrorMessage`）依次做四件事：把引号包裹的内容替换为
`…`、把 ISO 时间戳与时刻替换为 `…`、把 UUID 与长十六进制串替换为 `…`、
把所有数字替换为 `…`。归一化后如果只剩下占位符（没有任何字母或汉字），
该条被丢弃，不会形成噪声分组。

### 3.2 `buildToolPermissionTable`

`catalog` 接受两种形态：数组，或 `{tools: [...]}` 包装。每一项被规整为：

| 输出字段 | 来源 | 说明 |
| --- | --- | --- |
| `tool` | `id`（回退 `tool` / `name`） | 截断到 120 字符 |
| `source` | `source` 字符串，或 `source.kind` / `source.id` / `source.label` | 规整为字符串 |
| `risk` | `risk` | 只接受 `read-only \| write \| destructive`，其余一律 `unknown` |
| `requiresApproval` | 风险级别 + 目录项自身的 `requiresApproval` | 默认需确认清单为 `["destructive"]`，可由 `approvalRequired` 覆盖 |
| `description` | `description`（回退 `title`） | 截断到 200 字符 |

### 3.3 `runSecurityInspection`

巡检项 id 固定为 6 个，顺序固定：

| id | 标题 | 判定依据 | 触发时的严重级别 |
| --- | --- | --- | --- |
| `exposed-listen-address` | 监听地址暴露面 | `config.listenAddress` / `host` / `bindAddress` / `address` 等于 `0.0.0.0`、`::`、`*`、`all`、`any` | warning |
| `plaintext-secret-config` | 配置中的明文凭据 | 配置键名命中 `api[-_]?key / secret / password / token / credential / private[-_]?key`，值是长度 ≥ 8 的字符串，且不是 `env:` / `file:` / `path:` / `ref:` / `vault:` / `${…}` 这类引用 | critical |
| `destructive-tool-without-approval` | 破坏性工具的确认要求 | 目录里 `risk === "destructive"` 的工具显式声明 `requiresApproval === false`；或 `config.approvalRequired` 里没有 `destructive` | critical |
| `over-broad-file-root` | 文件根目录范围 | `storageRoots` 含 `/`、`\`、`*` 或 `C:` 这类文件系统根 | critical |
| `scheduled-check-failure` | 定时巡检失败 | `scheduledChecks` 中 `lastStatus` / `status`（或 `lastResult.status`）属于 `error / failed / failure / unhealthy` | warning |
| `repeated-audit-failure` | 重复失败聚合 | `summarizeAuditEntries(entries).repeatedErrors` 非空 | warning |

每条 finding 的形状固定为
`{id, title, detail, evidence, recommendation, severity}`，其中 `evidence`
写明结论来自哪个字段（例如 `config.listenAddress = 0.0.0.0`、
`storageRoots 包含 /`、`audit entries: … × 3`）。

`summary` 形如 `{critical, warning, info, total}`，是全部 finding 按严重级别
的计数。

## 4. 安全设计

1. **不臆造结论。** 巡检的每个判定都指向传入数据里的一个具体字段；传入
   空数据时 6 个巡检项全部返回空 finding、`summary.total === 0`。测试
   「runSecurityInspection does not invent a finding when no data is passed」
   把这一点钉死。
2. **不臆造风险级别。** 目录里没有声明的风险一律记为 `unknown`，不猜成
   `read-only`。
3. **不回显明文凭据。** 明文密钥的 finding 里只出现 `maskSecret()` 的结果
   （前 2 位 + 8 个 `*`），长度也被固定住，不泄露密钥长度。
4. **不重新实现执行判定。** 模块只描述「是否需要确认」，判定仍然只在
   `execution-policy.mjs:78-92` 一处发生。本模块没有 `evaluate()`，没有
   任何执行入口。
5. **不写文件、不读文件。** 全部逻辑是内存中的对象变换，模块可以安全地
   在一个受限环境里运行。
6. **聚合不泄露原文。** 错误分组的消息是归一化后的文本，原始消息中的数字、
   时间戳与引号内容被替换，避免报告本身成为新的敏感信息载体。
7. **零第三方依赖。** 只用 ESM 与 JavaScript 内建能力；`node:crypto` 都不
   需要（掩码是纯字符串处理）。

## 5. 未改变的红线

- 未执行任意 shell；本阶段没有任何执行入口；
- 未导入或执行任何 Skill；导入的 Skill 依旧不执行；
- 未放宽任何确认要求：破坏性操作仍然需要服务端签发的一次性确认；
- 未改变只读模式与总开关：`execution-policy.mjs` 的三种模式
  （`normal` / `read-only` / `halted`）语义不变；
- 未改变 API 不持久化 prompt 的现状；
- 未新增 HTTP 路由，未新增鉴权、限流、白名单规则；
- 未修改 `fnos-nas-agent` 的任何既有文件；
- 未执行 `git commit` / `git push`。

## 6. 测试清单

```bash
node --test tests/phase-160-security-audit.test.mjs
```

共 30 个用例，全部通过（`# pass 30 / # fail 0`）：

| # | 用例 | 覆盖点 |
| --- | --- | --- |
| 1 | summarizeAuditEntries counts total, actions and outcomes | 总量与两个维度计数 |
| 2 | summarizeAuditEntries reports only the failures that happened at least twice | `count >= 2` 过滤 |
| 3 | summarizeAuditEntries normalizes timestamps and quoted identifiers out of the message | 消息归一化 |
| 4 | summarizeAuditEntries orders the repeated errors by count | 排序稳定性 |
| 5 | summarizeAuditEntries honours the limit | `limit` 生效 |
| 6 | summarizeAuditEntries lists the recent failures | `recentFailures` 形状与排序 |
| 7 | summarizeAuditEntries tolerates an empty or invalid input | 空输入不抛错 |
| 8 | normalizeErrorMessage drops a message that only carries placeholders | 纯占位符消息被丢弃 |
| 9 | buildToolPermissionTable lists every tool with its source and risk | 权限表字段完整 |
| 10 | buildToolPermissionTable marks the destructive tools as needing approval | 破坏性工具需确认 |
| 11 | buildToolPermissionTable accepts a widened approval list | `approvalRequired` 覆盖 |
| 12 | buildToolPermissionTable accepts a {tools: []} wrapper and skips broken entries | 包装形态与脏数据 |
| 13 | buildToolPermissionTable reports an unknown risk instead of inventing one | 未知风险不臆造 |
| 14 | maskSecret keeps only the first two characters and never the full value | 掩码不回显 |
| 15 | maskSecret returns an empty string for an empty or non string value | 空值语义 |
| 16 | runSecurityInspection returns the six fixed sections in a stable order | 巡检项 id 与顺序固定 |
| 17 | runSecurityInspection does not invent a finding when no data is passed | **无数据不臆造** |
| 18 | runSecurityInspection reports an exposed listen address | SEC17 暴露面 |
| 19 | runSecurityInspection stays quiet for a loopback listen address | 正常地址不误报 |
| 20 | runSecurityInspection reports a plaintext secret and masks it in the evidence | 明文凭据 + 掩码 |
| 21 | runSecurityInspection does not report a secret reference as a plaintext secret | 引用式配置不误报 |
| 22 | runSecurityInspection reports a destructive tool that declares it needs no approval | SEC03/破坏性工具 |
| 23 | runSecurityInspection reports a destructive tool when the policy drops it from the approval list | 策略侧缺口 |
| 24 | runSecurityInspection stays quiet when the destructive tools keep their approval | 不误报 |
| 25 | runSecurityInspection reports an over broad storage root | 文件根目录过宽 |
| 26 | runSecurityInspection stays quiet for a normal storage volume | 正常卷不误报 |
| 27 | runSecurityInspection reports a failed scheduled check | 定时巡检失败 |
| 28 | runSecurityInspection reports a repeated audit failure | O06 错误聚合 |
| 29 | runSecurityInspection counts the findings by severity | `summary` 计数 |
| 30 | runSecurityInspection gives every finding an id, a severity and a recommendation | finding 形状完整 |

## 7. 集成说明

本阶段**没有**接入运行时；以下为后续集成步骤：

1. **审计记录的来源。** `audit-log.mjs` 只追加写 `audit.jsonl`，没有读取
   接口。要生成审计报告，需要一个读取侧（可复用 `app/audit-log.mjs` 的
   `filePath()` 与轮转文件名 `audit.jsonl.1`），并把解析后的记录数组传给
   `summarizeAuditEntries()`。
2. **工具目录的来源。** `tool-registry.mjs` 的 `list()` 返回
   `{id, title, description, risk, inputSchema, source:{id,kind,label}}`，
   可直接作为 `buildToolPermissionTable()` 的输入（`source` 会被规整成
   `kind` 字符串）。**注意**：注册表目前的 `normalizeTool()`（`:73-89`）
   不输出 `requiresApproval` 字段，所以「显式声明无需确认」这一条巡检在
   接入注册表后不会触发；真正的确认判定仍然由
   `execution-policy.mjs:78-92` 负责，报告层只是描述它。
3. **巡检数据的来源。** `config` 建议由 `server.mjs` 已经持有的执行模式
   （`execution-policy.mjs` 的 `mode()` / `source()`）与文件根目录
   （`file-manager.mjs:144` 的 `getRoots()`）拼装；
   `scheduledChecks` 建议取自 `scheduled-health-checks.mjs` 的 `list()`，
   其返回项已含 `lastStatus`（`:265`）。
4. **暴露方式。** 建议新增一个只读路由（例如 `/api/security/inspection`），
   由服务器读取数据 → 调用 `runSecurityInspection()` → 原样返回；
   报告本身不含任何写操作，因此不需要新的确认流程。
5. **文档索引。** 本文档需要登记到 `docs/README.md` 的索引，并在
   `README.md` 的「Current capabilities」清单里补一条；这两处按既定分工
   由集成方统一同步，本阶段未改动。

## 8. 后续建议

1. 为 `audit-log.mjs` 补一个只读的 `read()` / `tail(n)`，让审计报告不必
   自己去解析 `audit.jsonl`。
2. 把「明文密钥」检测接到 `model-provider-store.mjs` 的实际配置上：目前
   该模块用 AES-256-GCM 信封保存凭据（`model-provider-store.mjs:193-202`），
   巡检应确认数据目录里没有遗留的明文 `apiKey` 字段。
3. 在巡检项里补一条「审计日志轮转」检查：日志超过 `maxBytes`（默认 1MiB）
   时是否按预期轮转，避免长期运行后审计记录被截断。
4. 工具权限表可以作为 UI 的一个只读页：按 `source`（builtin / skill / mcp）
   分组，让操作者一眼看到外部来源的工具。
5. 为 `summarizeAuditEntries()` 增加一个按时间窗过滤的选项（如
   `{since}`），让报告可以回答「最近一小时」这类问题。

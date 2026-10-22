# Phase 144 — Skill Package Format

## 背景

Phase 103 起的静态审查只覆盖**单个 manifest 文件**：服务端读取 `SKILL.md`
的 frontmatter，检查 `name` / `description`，再做一次源码模式扫描
（`apps/fnos-nas-agent/app/skill-source-review.mjs`）。审查对象是"压缩包里的
一个文件"，不是"一个包"。

由此带来三个结构性缺口：

1. **没有包结构概念。** 压缩包里除了 `SKILL.md` 还有什么、放在哪些目录、
   是否越界、是否超限，服务端无法给出结论。
2. **Skill 正文从不进入模型上下文。** `SKILL.md` 的正文（instructions）
   没有任何解析入口，因此 Skill 无法承载"渐进披露"式的能力说明。
3. **没有渐进披露的载体。** `references/` / `scripts/` / `tests/` 这种
   Claude Code 风格的包结构在仓库里没有任何位置约定。

本阶段只做**只读解析与描述**：把一个 Skill 压缩包解析成一份结构化的包描述，
让审查层、UI 层和后续的上下文装载层有一个共同的、单一的事实来源。

## 变更边界

| 文件 | 变更 |
| --- | --- |
| `apps/fnos-nas-agent/app/skill-package.mjs` | 新增：包规范解析器 |
| `tests/phase-144-skill-package-format.test.mjs` | 新增：解析器行为测试 |
| `docs/phase-144-skill-package-format.md` | 新增：本文件 |

本阶段**没有**修改任何既有文件。`skills.mjs`、`skill-manifest.mjs`、
`skill-source-review.mjs`、`server.mjs` 与前端均未触碰；解析器尚未接入
HTTP 路由，导入流程的行为完全不变。

## 包结构约定

解析器识别如下结构（`<root>/` 表示可选的顶层目录前缀）：

```
<root>/SKILL.md          必需，frontmatter + instructions 正文
<root>/metadata.json     可选，version / agentApiRange / capabilities / license
<root>/references/**     可选，深层参考材料
<root>/scripts/**        可选，辅助脚本（本阶段从不执行）
<root>/tests/**          可选，包自检脚本（本阶段从不执行）
```

- `SKILL.md` 路径匹配 `^(?:[^/]+/)*SKILL\.md$`，包内**有且仅有一份**。
- `<root>` 由 `SKILL.md` 自身的位置推导；`<root>` 之外的条目被忽略并记
  `entry-outside-package-root`（warning）。
- `metadata.json` 中的字段优先于 frontmatter 中的同名字段；两者同时声明且
  不一致时记 `metadata-name-mismatch` / `metadata-description-mismatch`。
- `capabilities` 接受数组或逗号分隔字符串。

## 导出 API

`apps/fnos-nas-agent/app/skill-package.mjs`

```js
export function parseSkillPackage(buffer, { limits } = {})
// → { status, manifest, instructions, references, scripts, tests, inventory, findings }
```

| 字段 | 说明 |
| --- | --- |
| `status` | `"ok"` / `"incomplete"`（有 warning）/ `"invalid"`（有 error） |
| `manifest` | `{ name, description, version, agentApiRange, capabilities[], license }` |
| `instructions` | `SKILL.md` frontmatter 之后的正文（已剥离前导空行） |
| `references` / `scripts` | `[{ path, bytes, sha256 }]`，`path` **相对包根**（如 `references/overview.md`） |
| `tests` | `[{ path, bytes }]`，`path` 同样相对包根 |
| `inventory` | 包内全部已读取文件的 `[{ path, bytes, sha256 }]`，`path` 是**压缩包内路径**（含 `<root>/` 前缀） |
| `findings` | `[{ rule, path, message, severity }]`，`severity` 为 `"error"` / `"warning"` |

配套导出：

- `SKILL_PACKAGE_DIRECTORIES` — `["references", "scripts", "tests"]`。
- `SKILL_PACKAGE_LIMITS` — 默认限额表。
- 限额常量：`MAX_PACKAGE_BYTES`（25 MiB）、`MAX_PACKAGE_ENTRIES`（500）、
  `MAX_PACKAGE_UNCOMPRESSED_BYTES`（64 MiB）、`MAX_MANIFEST_BYTES`、
  `MAX_METADATA_BYTES`（各 64 KiB）、`MAX_INSTRUCTIONS_BYTES`（256 KiB）、
  `MAX_REFERENCE_FILE_BYTES` / `MAX_SCRIPT_FILE_BYTES` /
  `MAX_TEST_FILE_BYTES`（各 1 MiB）、`MAX_REFERENCE_FILES`（64）、
  `MAX_SCRIPT_FILES` / `MAX_TEST_FILES`（各 32）、`MAX_NAME_LENGTH`（100）、
  `MAX_DESCRIPTION_LENGTH`（1000）、`MAX_CAPABILITIES`（64）、
  `MAX_CAPABILITY_LENGTH`（64）、`MAX_LICENSE_LENGTH`（100）、
  `MAX_AGENT_API_RANGE_LENGTH`（120）、`MAX_FINDINGS`（64）。

`limits` 可以逐项覆盖默认值，便于在测试与后续阶段复用同一套限额语义。

## 安全设计

解析器**只读**：

- 不写磁盘，不把压缩包解压到文件系统。
- 只在内存中解析 ZIP 中央目录（`readCentralDirectory`），再通过
  `skill-archives.mjs` 已有的 `extractZipEntry` 读取单个条目，不重复实现
  ZIP 解压。
- **不执行**导入包里的任何内容：`scripts/` 与 `tests/` 只被登记路径、大小
  和哈希，不解释、不运行。

每个问题都只记录为 finding，不抛异常，调用方自行决定如何处置。路径安全
沿用并加强了 `skill-archives.mjs` 的规则：绝对路径、盘符、`..` 越界、
`.` 段、反斜杠分隔符、空路径段、控制字符、符号链接条目、非常规文件类型、
加密条目、非常规压缩方法，全部记为 `error`。

## Findings 规则清单

| 规则 | 严重级别 | 触发条件 |
| --- | --- | --- |
| `package-not-a-zip` | error | 输入不是 Buffer，或中央目录不可读 |
| `package-too-large` | error | 压缩包超过 `maxPackageBytes` |
| `package-too-many-entries` | error | 条目数超过 `maxEntries` |
| `package-uncompressed-size-exceeded` | error | 声明的解压总大小超限 |
| `entry-name-too-long` | error | 条目名超过 1024 字节 |
| `entry-backslash-path` | error | 路径使用反斜杠分隔符 |
| `entry-absolute-path` | error | 绝对路径或盘符路径 |
| `entry-control-characters` | error | 路径含控制字符 |
| `entry-path-traversal` | error | `..` 越界 |
| `entry-current-directory` | error | 含 `.` 段 |
| `entry-empty-path-segment` | error | 含空路径段 |
| `entry-encrypted` | error | 加密条目 |
| `entry-strong-encrypted` | error | 强加密条目 |
| `entry-unsupported-compression` | error | 非 store/deflate 压缩方法 |
| `entry-symbolic-link` | error | 符号链接条目 |
| `entry-special-file-type` | error | 非常规文件类型 |
| `entry-duplicate-path` | error | 重复条目路径（大小写不敏感） |
| `entry-outside-package-root` | warning | 条目位于包根之外，被忽略 |
| `entry-extract-failed` | error | 条目无法从压缩包读出 |
| `missing-skill-manifest` | error | 没有 `SKILL.md` |
| `multiple-skill-manifests` | error | 多于一份 `SKILL.md` |
| `manifest-too-large` | error | `SKILL.md` 超过 `maxManifestBytes` |
| `manifest-not-valid-utf8` | error | `SKILL.md` 不是合法 UTF-8 |
| `manifest-missing-frontmatter` | error | `SKILL.md` 没有 frontmatter 块 |
| `manifest-control-characters` | warning | `SKILL.md` 含控制字符 |
| `instructions-too-large` | error | instructions 正文超限 |
| `missing-metadata-json` | warning | 缺少 `metadata.json` |
| `metadata-too-large` | error | `metadata.json` 超限 |
| `metadata-not-valid-utf8` | error | `metadata.json` 不是合法 UTF-8 |
| `invalid-metadata-json` | error | `metadata.json` 不是合法 JSON |
| `metadata-not-an-object` | error | `metadata.json` 顶层不是对象 |
| `unknown-metadata-field` | warning | 出现未知字段 |
| `metadata-name-mismatch` / `metadata-description-mismatch` | error | 两处声明冲突 |
| `missing-name-field` / `missing-description-field` | error | 未声明名称/描述 |
| `name-too-long` / `description-too-long` | error | 超出长度限制 |
| `invalid-metadata-version` | error | 版本号不是语义化版本 |
| `invalid-metadata-agent-api-range` | error | agent API 范围非法 |
| `invalid-metadata-capabilities` | error | 能力标识非法 |
| `too-many-capabilities` | error | 能力数量超限 |
| `invalid-metadata-license` | error | 许可证超长 |
| `unsupported-package-file` | warning | 包根下的非白名单文件 |
| `unsupported-package-directory` | error | 非白名单目录 |
| `missing-references-directory` / `missing-scripts-directory` / `missing-tests-directory` | warning | 缺少可选目录 |
| `too-many-reference-files` / `too-many-script-files` / `too-many-test-files` | error | 目录内文件数超限 |
| `reference-file-too-large` / `script-file-too-large` / `test-file-too-large` | error | 单文件超限 |

## 未改变的红线

本阶段**没有触碰**任何既有安全边界：

- 任意 shell 执行仍然禁用（`agent-core.mjs` 的 `arbitraryExecutionEnabled`
  恒为 `false`），解析器不引入任何执行路径。
- 导入的 Skill 从不被执行；本阶段新增的 `scripts/` / `tests/` 只是被登记
  的字节与哈希，同样不会被执行。
- 危险操作的一次性确认机制（`action-approval-service.mjs`）、只读模式与
  总开关（`execution-policy.mjs`）、审计（`audit-log.mjs`）均未改动。
- API 不持久化 prompt 的既有约定未变：解析器是纯函数，不写任何状态。
- 解析器不产生新的文件写入点，也不访问压缩包之外的路径。

## 测试

`tests/phase-144-skill-package-format.test.mjs`（23 个用例，`node --test`，
零外部依赖）覆盖：

- 完整包：`status === "ok"`、manifest 字段、instructions 正文、三类目录的
  路径与 inventory 顺序。
- SHA-256 稳定性：对同一批字节计算出的哈希与 `node:crypto` 独立计算一致。
- 缺 `SKILL.md`、多份 `SKILL.md`。
- 路径安全：`..` 越界、绝对路径、反斜杠、符号链接条目。
- 非白名单目录（`assets/`）、根下非白名单文件（`README.md`）。
- 包根之外的条目被忽略（`pkg/SKILL.md` + `other/notes.md`）。
- `metadata.json` 非法 JSON、非法版本号 / agent API 范围 / 能力标识。
- 无 frontmatter 的 manifest。
- 超限：压缩包大小、条目数、单文件大小、单目录文件数。
- references 多文件哈希稳定性与同字节幂等解析（两次解析结果完全一致）。
- 缺可选目录时状态为 `incomplete`。
- 非 ZIP 输入。

普通压缩包用共享的 `tests/helpers/skill-archive.mjs` 的 `makeZip` 构造；
符号链接等需要改写中央目录属性的用例在测试文件内单独构造。

全部用例在 Windows 上通过：

```
node --test tests/phase-144-skill-package-format.test.mjs
# tests 23
# pass 23
# fail 0
```

## 集成说明（由集成方统一处理）

本阶段按约定**不修改** `README.md` 与 `docs/README.md`，以下两处需要在集成
时同步：

1. `docs/README.md` 的文档索引需要新增 `phase-144-skill-package-format.md`
   一行（`tests/docs-links.test.mjs` 会校验"docs/ 下每个文档都被索引列出"，
   未同步会导致该用例失败）。
2. `README.md` 的 `### Current capabilities` 清单可以补一条"Skill 包规范
   解析（只读）"；`### Foundations` 不需要改动。

## 后续建议（不在本阶段范围）

- 把 `parseSkillPackage` 接到导入流程：审查结论里附带包描述，使
  "静态审查"从"看一个文件"升级为"看一个包"。
- 把 `instructions` 作为渐进披露的第一层：仅在 Skill 被启用或模型请求时
  才注入上下文，`references/` 保持按需加载。
- 把包结构的 `metadata.json` 字段与 Skill 记录（`skills.mjs`）打通，让
  `version` / `agentApiRange` 成为安装前置条件。

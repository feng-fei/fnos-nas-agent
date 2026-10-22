# Phase 189 — 批量重命名（F10 规划器与可回滚执行骨架）

## 背景

能力矩阵 F10「批量重命名」当前为 **Open**（`docs/marvis-capability-matrix.md`），仓库已有 `apps/fnos-nas-agent/app/file-manager.mjs` 的单文件改名能力，但缺少批量规划与失败回滚。真正落盘涉及审批链、审计与文件系统竞态，不适合塞进规划层，因此本阶段只交付两部分：

- `planBatchRename`：把「条目 + 规则」转换成确定性的 rename 计划，并列出冲突与跳过项；
- `applyBatchRenamePlan`：按计划顺序执行注入的 `rename(from, to)`，任一步失败逆序回滚。

模块是纯 ESM、零依赖、零 I/O：不导入 `node:fs` / `node:child_process` / `node:path`，不读取也不写入任何文件。真正的落盘由 Lead 接线到既有 `fileManager.rename` 与审批链。

## API 与字段

### `BATCH_RENAME_MODES`

`["replace", "prefix-suffix", "sequence", "normalize"]`，四种模式的白名单。

### `planBatchRename(entries, rule, { maxEntries = 200 } = {})`

条目结构：`{ path: string, name: string, kind: "file" | "dir" }`，`path` 为完整相对路径，`name` 必须等于 `path` 的 basename（不一致视为 `invalid-entry`，避免计划与磁盘真实名称错位）。

返回：

| 字段 | 说明 |
| --- | --- |
| `ok` | 无 `errors` 且无 `conflicts` 时为 `true` |
| `errors` | `[{ code, message }]`，规则/整体性错误 |
| `plan` | `[{ from, to }]`，顺序与 `entries` 一致，仅含可执行项 |
| `conflicts` | `[{ kind, path, detail }]`，任一冲突都会让 `ok=false` |
| `skipped` | `[{ path, reason }]`，`reason` 为 `noop` 或 `invalid-entry` |
| `summary` | `{ total, planned, skipped, conflicts }` |

错误码：

| code | 触发条件 |
| --- | --- |
| `invalid-entries` | `entries` 不是数组 |
| `invalid-rule` | `rule` 不是对象 |
| `invalid-mode` | `rule.mode` 不在白名单 |
| `empty-find` | `replace` 模式的 `find` 为空字符串（含未提供） |
| `too-many-entries` | `entries.length > maxEntries`；此时直接拒绝，`plan` / `conflicts` / `skipped` 均为空，不产生部分计划 |

冲突 kind：

| kind | 触发条件 |
| --- | --- |
| `empty-name` | 结果名为空串 |
| `path-separator` | 结果名含 `/` 或 `\` |
| `dot-dot` | 结果名恰为 `.` 或 `..` |
| `target-exists` | 目标名与同目录另一条目的现有 `name` 相同 |
| `duplicate-target` | 本计划内两条条目得到同一目录下的同一目标名 |

判定顺序（单条目）：结构校验 → 结果名红线 → `noop` 跳过 → 计划内重复目标 → 同目录既有重名。每个条目最多产生一条冲突；冲突项不进入 `plan`。

### `applyBatchRenamePlan(plan, { rename })`

- `rename` 必须注入为 `async (from, to)` 函数，缺失或非函数抛 `TypeError`；
- `plan.ok !== true` 抛 `code = "plan-not-applicable"` 的错误，绝不执行半成品计划；
- 返回 `{ applied, failed, rolledBack, rollbackFailures }`：
  - `applied`：正向成功调用 `rename` 的次数（含随后被回滚的）；
  - `failed`：失败步骤的 `{ from, to, message }`，全成功时为 `null`；
  - `rolledBack`：成功回滚的次数；
  - `rollbackFailures`：`[{ from, to, source, message }]`，逆序回滚失败的每一步单独列出，绝不静默；`source` 为当初的正向步骤。

## 四种模式语义与示例

| 模式 | 默认参数 | 语义 | 示例 |
| --- | --- | --- | --- |
| `replace` | `find`（必填）、`replace=""`、`caseSensitive=true` | 对 basename 做字面量替换（`split`/`join`，`find` 不作为正则解释） | `find:"photo", replace:"image"`：`photo.jpg → image.jpg` |
| `prefix-suffix` | `prefix=""`、`suffix=""` | 在 basename 两端拼接，扩展名视作名称的一部分 | `prefix:"2024-", suffix:"-final"`：`report.doc → 2024-report.doc-final` |
| `sequence` | `start=1`、`step=1`、`width=3`、`separator="-"`、`keepExtension=true` | 按 `entries` 下标编号，追加为 `stem + separator + 序号 + ext`；`keepExtension` 仅对 `kind="file"` 生效，目录不拆扩展名 | `photo.jpg → photo-001.jpg`；`keepExtension:false` 时 `photo.jpg → photo.jpg-001` |
| `normalize` | `lowercase=true`、`spacesTo="-"`、`trim=true` | 先 `trim`，再把连续空白（含单个空格）压成一个 `spacesTo`，最后按需小写 | `"My Report  FINAL.txt" → "my-report-final.txt"` |

`caseSensitive=false` 时按字面量做大小写不敏感搜索；若某字符大小写折叠会改变长度（Unicode 特例），退回大小写敏感替换以保证结果确定，不做模糊匹配。

## 安全红线

1. **不碰文件**：模块不 import 文件系统与子进程模块，`plan` 只是数据；执行必须由调用方注入 `rename`，天然经过既有 `fileManager.rename` 的边界校验与审批链。
2. **只改 basename**：`dir` 从原 `path` 逐字节截取并原样拼回（`/` 与 `\` 两种分隔符都保留），规划器没有任何改写目录部分的路径分支。
3. **冲突即拒绝**：出现任一冲突，`ok=false`；此时无冲突条目仍保留在 `plan` 中供调用方展示，但 `applyBatchRenamePlan` 会整体拒绝执行，因此不会出现「执行一半才发现冲突」。
4. **回滚逆序、失败可见**：正向按顺序执行；失败后对已成功项按相反顺序调用同一 `rename`（`to → from`）。回滚失败逐条记录在 `rollbackFailures`，调用方必须检查，不做吞异常。
5. **不产生部分计划**：超过 `maxEntries` 时整体拒绝，`plan` 为空数组。

## 测试

自验命令（仓库根执行）：

```powershell
node --check apps/fnos-nas-agent/app/batch-rename.mjs
node --check tests/phase-189-batch-rename.test.mjs
node --test tests/phase-189-batch-rename.test.mjs
```

结果：**31 tests / 31 pass / 0 fail**。覆盖四种模式各 ≥2 例、扩展名保留与丢弃、目录部分逐字节保留（含反斜杠路径）、空 `find`、结果含分隔符、`.`/`..` 目标、空结果名、同目录既有重名、计划内重复目标、`noop` 跳过、超限拒绝（显式与默认 200 边界）、非法条目跳过、apply 成功顺序、第二条失败回滚第一条、首条失败无回滚、回滚失败被记录、缺 `rename` / 非函数 `rename` 抛 `TypeError`、`ok=false` 拒绝执行、输出确定性与顺序。

## 遗留

- **落盘与审批不在本阶段**：`applyBatchRenamePlan` 需要 Lead 注入 `fileManager.rename`，并把整批计划接入现有审批链（单条 rename 的审批粒度是否要提升为整批审批，需要产品确认）。
- **落盘时的竞态**：规划基于调用方传入的快照，真实执行前目标可能已被其他进程占用；这需要执行端在 `rename` 内部复用 `file-manager.mjs` 的 `ensureAbsent` 语义并明确失败策略（当前实现只能保证回滚，不能保证原子性）。
- **更多名称红线**：结果名长度、控制字符、`trim` 前后不一致等由 `file-manager.mjs` 的 `safeName` 在执行时兜底，规划器只覆盖契约要求的 5 类冲突。
- **不支持交换重命名**（A→B、B→A）：当前 `target-exists` 取保守语义，即使对方也在本批中改走也会判冲突，需要多轮计划或临时名策略。
- **文档索引待补**：`tests/docs-links.test.mjs` 要求 `docs/README.md` 列出 `docs/` 下每个 Markdown。当前 `docs/README.md` 尚未收录 `phase-188`、`phase-190` 与本篇 `phase-189`（前两者在本阶段开始前就缺失，该用例已处于失败状态）。按约束本阶段不修改既有文件，Lead 需统一补上索引行。

# Phase 187 — 导入时的 Skill 包结构审查

## 背景

Phase 144 交付了一个完整的 Skill 包解析器（`apps/fnos-nas-agent/app/skill-package.mjs`，
导出 `parseSkillPackage`），它能校验 `SKILL.md` 元数据、`metadata.json` 一致性、
`references/`、`scripts/`、`tests/` 的边界与符号链接，并把结论分成
`ok` / `incomplete` / `invalid` 三档。但这个解析器**从未被任何生产模块导入**：
导入一个 Skill 压缩包时，服务端只做源码静态扫描（`skill-source-review.mjs`），
包结构是否完整、`references/` 与 `scripts/` 各有多少、缺了 `metadata.json`
这些结论既不会落库，也不会显示在页面上。用户看到一个 `pending_review` 的技能，
并不知道这个包本身是不是「一个能被装起来的包」。

本阶段把已有的解析器接进导入流程，让包结构审查成为与源码审查同级的第二个闸门。

## 改动

| 文件 | 改动 |
| --- | --- |
| `apps/fnos-nas-agent/app/skills.mjs` | 新增 `reviewSkillPackageBuffer(buffer)`（导出，纯函数）、`normalizePackageReview(value)`；`register()` 在隔离区写入后计算一次包结构结论并随记录保存；`load()` 读取时归一化；`reviewLegacyRecords()` 升级旧记录时补算 |
| `apps/fnos-nas-agent/app/ui/pages.js` | Skill 卡片在源码审查结论下方渲染「包结构：…；references N；scripts N；tests N；问题：…」，全部 `textContent` |
| `tests/phase-187-skill-package-review.test.mjs` | 7 个用例：`ok` 计数、只有警告 → `incomplete`、缺 `SKILL.md` → `invalid`、非 zip → `invalid`、导入路径确实调用了审查函数并把结论写进记录、记录被手改后归一化、页面渲染断言 |

## 契约

记录上新增 `packageReview` 字段（可为 `null`）：

```text
{
  status: "ok" | "incomplete" | "invalid",
  references: number,   // references/ 下的文件数
  scripts: number,      // scripts/ 下的文件数
  tests: number,        // tests/ 下的文件数
  findings: [{ rule: string, severity: "error" | "warning" }],  // 最多 8 条，不含文件内容
  reviewedBy: "server" | null
}
```

- 结论由服务端从**隔离区里的原始字节**算出，客户端传上来的任何字段都不被采用。
- `reviewedBy` 只在服务端计算时写入 `"server"`；`load()` 会把外部写入的
  `reviewedBy` 一律归一化为 `null`，因此手改 `skills.json` 无法伪造一次「服务端已审查」。
- 解析器抛错或字节损坏时结论为 `null`，**永远不会给一个凭空的 `ok`**。
- 结论不含任何文件内容或路径拼接结果，只有规则名、严重级别与三个计数。

## 安全边界

1. 只在隔离区字节上解析，不执行包内任何脚本，不解压到工作目录。
2. `error` 级别的发现意味着包结构不可用；`incomplete` 只表示有警告（例如缺
   `metadata.json`），是否允许安装仍由既有的批准流程决定 —— 本阶段不改变安装闸门，
   只是把「这个包长什么样」变成可审查的事实。
3. 审查在登记成功后同步计算，失败只让 `packageReview` 为空，不影响登记本身。

## 测试

```text
node --test tests/phase-187-skill-package-review.test.mjs   # 7 pass / 0 fail
```

全量 `node --test` 见阶段提交说明：新增 7 个用例全部通过，其余失败项与
Windows 环境下的既有失败集合一致（逐条对比，无新增）。

## 遗留

- 隔离区的安全读写依赖 POSIX 目录描述符，Windows 上 `importArchive` 本身不可用；
  因此导入链路的端到端执行在 Linux CI 上覆盖，Windows 上覆盖同一导出函数的契约。
- `references/`、`scripts/` 的数量尚未用于安装策略（例如「带 `scripts/` 的包必须
  单独批准」），当前只做展示与落库。

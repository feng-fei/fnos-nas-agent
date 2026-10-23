# Phase 217：备份前检查

## 背景

「备份/迁移之前先看一眼」是 NAS 运维里最常被跳过、又最容易出事的一步：卷已经只读了、
空间只剩 3%、某块盘 SMART 已经报失效，备份任务照样会被点下去。对照表里 `SEC13 Backup pre-check`
一直是 Open，仓库里只有零散的能力（系统快照、容量趋势、服务状态、SMART、诊断报告），
没有一个地方把它们拼成一句「现在能不能安心备份」。

这一阶段补的就是这句话，而且只做判定：不采集、不写盘、不改配置。

## 设计

新增 `apps/fnos-nas-agent/app/backup-precheck.mjs`（纯函数、零 import、零 I/O）：

```js
buildBackupPrecheck(input, options)
// input: { snapshot, capacity, services, smart, diagnostics }
// options: { warnFreeRatio, blockFreeRatio, warnDaysToFull, blockDaysToFull }
// → { verdict, thresholds, checks, summary, actions }
```

- 七个检查项（`BACKUP_CHECK_IDS`）：存储可见性、可用空间、只读挂载、容量趋势、系统服务、
  磁盘健康、近期诊断。
- 每项状态只有四种：`ok / warn / blocked / unknown`。**unknown 不等于 ok**：没采到数据必须
  显示成「未知」，不能冒充正常。
- 只有明确的危险才 `blocked`：只读挂载、可用空间低于 5%、容量趋势 7 天内写满、SMART 报失效。
  其余一律降级成 `warn`，并给出可执行的建议——体检的作用是提醒，不是拦住用户。
- 阈值可被调用方覆盖，并且会被夹回合理区间（可用比例 1%–90%，天数 ≥1/≥0.5）。
- 输入形状做窄范围归一化：`values.disks` 与 `values.volumes` 两种来源都认，缺字段就是 unknown。

服务端 `GET /api/backup/precheck`（会话鉴权、只读 GET、审计名 `backup.precheck`）把已有采集器
拼起来喂给这个纯函数：系统快照（并顺带写一条容量采样）、服务状态、SMART（采集器开启时）。
诊断结论目前不由服务端代填，报告里如实写成 `inputs.diagnostics = "not-supplied"`，
对应检查项就是 unknown——这是刻意保留的诚实，而不是漏实现。

前端在「诊断与运维」页新增「备份前检查」卡片：一个按钮，结论 + 每个检查项的中文状态 + 建议清单 +
可展开的原始 JSON。

## 改动

| 文件 | 改动 |
| --- | --- |
| `apps/fnos-nas-agent/app/backup-precheck.mjs` | 新增：七个检查项的纯判定、阈值归一、建议生成 |
| `apps/fnos-nas-agent/app/server.mjs` | 新增 `GET /api/backup/precheck` 与审计名 `backup.precheck` |
| `apps/fnos-nas-agent/app/ui/index.html` | 运维页新增「备份前检查」卡片 |
| `apps/fnos-nas-agent/app/ui/pages.js` | `runOpsBackupPrecheck()`、结论/状态中文文案、按钮绑定 |
| `apps/fnos-nas-agent/tests/phase-217-backup-precheck.test.mjs` | 14 例：判定、阈值、归一化、接线 |
| `apps/fnos-nas-agent/tests/phase-217-backup-precheck-http.test.mjs` | 1 例：未登录 401（只读也要鉴权） |

## 安全与语义边界

- 接口是只读 GET，不写盘、不发外部请求、不改任何系统配置。
- 只读不等于不设防：未登录一律 401。
- 采集器关闭或数据缺失时，对应检查项是 `unknown`，报告中不会出现「正常」。
- 建议文案只解释「为什么」，不自动执行任何修复动作。

## 验证

- `node --test tests/phase-217-backup-precheck.test.mjs` → 14/14。
- `node --test tests/phase-217-backup-precheck-http.test.mjs` → 1/1（401 边界）。
- `node --check` 通过：`backup-precheck.mjs`、`server.mjs`、`pages.js`。
- 全量测试与失败集合对比见提交说明；release gate 通过。

## 遗留

- 诊断结论没有并入体检（服务端不代填），需要用户先生成一份诊断报告，或后续把诊断历史接进来。
- 卷级的只读状态依赖快照里是否带 `readOnly` 字段；没带就是 unknown，不猜。

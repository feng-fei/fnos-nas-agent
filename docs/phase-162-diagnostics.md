# Phase 162 — 故障诊断与根因候选

本阶段实现用户功能清单模块 03「AI 故障诊断与自动修复」的**诊断侧内核**：
把已经采集到的证据，确定性地归类为故障类别、排序出根因候选、给出置信度说明，
并产出一份可读的**故障诊断报告**，报告中的建议全部是**只读诊断**动作或
「需人工审批后执行」的表述。

覆盖的功能清单编号：

| 编号 | 名称 | 本阶段落点 |
| --- | --- | --- |
| D01 | 故障问诊 | `buildDiagnosticReport({ symptom })` 接收症状描述，并在报告中回显 |
| D03 | 故障分类 | `classifyEvidence(evidence)` → `storage` / `network` / `resource` / `permission` / `application` |
| D04 | 根因候选 | `rankCauses(evidence, { limit })` |
| D05 | 置信度说明 | 每条根因带 `confidence`，报告第 4 节给出三档语义 |
| D07 | 只读诊断 | `checks` / `readOnlyChecks`，只允许采集指标、查日志、读 SMART、查容器状态 |
| D12 | 故障报告 | `buildDiagnosticReport().report`（可读文本） |

## 1. 动机

Marvis 的故障诊断能力有一个容易被误用的形态：**遇到任何异常都给出一串"修复动作"**，
其中最常见也最危险的一种是「重启所有服务」。这种建议在存储介质已经失效、
RAID 阵列已经降级的场景里不仅无效，还会扩大损失——把还在读旧数据的进程全部打断，
把仅剩的健康副本也拖下水。

本阶段的取舍很明确：

1. **诊断与修复分离。** 本模块只产出诊断结论与只读建议，不产出任何写操作。
2. **置信度必须诚实。** 证据不足时不允许给出 `confirmed`，宁可给 `suspected`
   并把"补充证据"作为下一步。
3. **破坏性动作只能以「需人工审批后执行」表述。** 模块内置 `isSafeSuggestion()`，
   明确拒绝 `rm -rf /`、`mkfs`、`dd`、`mdadm --stop`、重建阵列、停止存储服务等
   会扩大损失的动作。

## 2. 变更边界

本阶段**只新增**三个文件：

| 文件 | 作用 |
| --- | --- |
| `apps/fnos-nas-agent/app/diagnostics.mjs` | ES module，纯函数，无 I/O、无模型调用、无第三方依赖 |
| `tests/phase-162-diagnostics.test.mjs` | `node --test` 用例 |
| `docs/phase-162-diagnostics.md` | 本文档 |

明确**没有**发生的事：

- 没有修改任何既有生产模块（含 `server.mjs`、UI、`agent-core.mjs`）；
- 没有新增、修改或删除任何 HTTP 路由；
- 没有修改 `README.md` / `docs/README.md` / 发布门禁脚本；
- 没有引入任何第三方依赖；
- 没有执行 `git commit` / `git push`。

本模块**不执行**任何命令、不做任何 I/O、不调用任何模型：
输入是"调用方已经采集好的证据"，输出是分类、候选、置信度与报告文本。

## 3. 导出 API 契约

```js
import {
  DIAGNOSTIC_CATEGORIES,
  DIAGNOSTIC_CONFIDENCE_LEVELS,
  classifyEvidence,
  classifyEvidenceDetail,
  rankCauses,
  buildDiagnosticReport,
  isSafeSuggestion
} from "../apps/fnos-nas-agent/app/diagnostics.mjs";
```

| 导出 | 签名 | 返回 | 说明 |
| --- | --- | --- | --- |
| `DIAGNOSTIC_CATEGORIES` | `readonly string[]` | `["storage","network","resource","permission","application"]` | 分类枚举，顺序即默认优先级 |
| `DIAGNOSTIC_CONFIDENCE_LEVELS` | `readonly string[]` | `["confirmed","likely","suspected"]` | 置信度枚举，由强到弱 |
| `classifyEvidence` | `(evidence) => string` | 分类名 | D03 故障分类；无法判定时返回 `"application"` |
| `classifyEvidenceDetail` | `(evidence) => {category, reason, signals}` | 分类 + 可解释原因 | `reason` 说明判定依据；无法判定时说明"按 application 处理" |
| `rankCauses` | `(evidence, {limit = 5}) => Cause[]` | 根因候选数组 | D04 根因候选 + D05 置信度 |
| `buildDiagnosticReport` | `({symptom, evidence, causes, now}) => Report` | 故障诊断报告 | D01 / D07 / D12 |
| `isSafeSuggestion` | `(action: string) => boolean` | 是否安全 | 拒绝一切扩大损失的动作 |

### 3.1 证据输入形态

`evidence` 接受数组或单条证据，每条可以是：

- 字符串：`"SMART overall-health self-assessment failed"`；
- 对象：`{ source, detail }`，其中 `detail` 亦可写作 `message` / `text` /
  `content` / `value` / `reason`；缺 `source` 时记为 `"evidence"`。

`detail` 会被截断到 200 字符，避免把整段日志塞进报告。

### 3.2 分类规则

| 类别 | 触发示例 |
| --- | --- |
| `storage` | SMART 报错、mdadm/RAID 降级、I/O error、EXT4/XFS 错误、只读重挂、ENOSPC |
| `network` | DNS 解析失败、Network is unreachable、No route to host、Connection refused、丢包 |
| `resource` | Out of memory / OOM / Killed process、load average 高位、CPU 100% |
| `permission` | Permission denied、EACCES、EPERM、401/403、Unauthorized / Forbidden |
| `application` | CrashLoopBackOff、no such image、segfault、core dumped、exit code 非零 |

判分类别按"强特征 3 分 / 弱特征 1 分"累加，取最高分；平分时按
`DIAGNOSTIC_CATEGORIES` 的顺序取靠前者。**无法判定时返回 `"application"`**，
并在 `classifyEvidenceDetail().reason` 中写明"无法判定具体类别，按 application 处理"。

### 3.3 根因候选与置信度

`rankCauses()` 对内置的 17 条根因规则逐条匹配，输出：

```js
{
  id: "storage-disk-failure",
  title: "磁盘介质或控制器失效（SMART 报错 / IO 错误）",
  category: "storage",
  confidence: "confirmed",
  evidence: [{ source: "smartctl", detail: "SMART overall-health self-assessment failed: FAILED!" }],
  checks: ["采集 SMART 全量属性（smartctl -a /dev/<disk>）", "..."]
}
```

置信度判定（**禁止在证据不足时给 `confirmed`**）：

| 置信度 | 条件 |
| --- | --- |
| `confirmed` | 命中该根因的**明确错误特征**（强信号） |
| `likely` | 未命中强信号，但同类证据 **≥ 2** 条互相印证 |
| `suspected` | 仅弱信号，仅作为排查方向 |

排序：先按置信度（confirmed > likely > suspected），再按命中证据条数，
最后按 `id` 字典序，保证输出稳定可复现。`limit` 默认 5。

### 3.4 故障报告

```js
const report = buildDiagnosticReport({
  symptom: "存储卷读写变慢并出现 IO 错误",
  evidence: [
    { source: "smartctl", detail: "SMART overall-health self-assessment failed: FAILED!" }
  ],
  now: "2026-10-22T00:00:00.000Z"
});
// => { symptom, category, summary, causes, readOnlyChecks, nextSteps, escalation, report }
```

`report` 是可读文本，分 7 节：症状 / 证据 / 根因候选 / 置信度说明 /
只读诊断建议 / 下一步 / 人工升级。

- `readOnlyChecks` 只包含只读诊断动作：采集指标、查日志、读 SMART、查容器状态。
- `nextSteps` **不出现删除 / 重建 / 格式化类动作**；破坏性动作只能以
  「需提交人工审批后由人工执行」表述。
- `escalation.required` 表示是否需要人工介入；磁盘失效 / 阵列降级类根因
  必然触发升级，证据不足同样触发。

## 4. 安全设计

1. **不执行任何东西。** 模块没有 `node:fs` / `node:net` / `node:http` /
   `child_process` / `fetch`，测试用例对此做源码级断言。
2. **不调用模型。** 全部结论来自确定性规则表，同一输入必得同一输出
   （测试用例断言 `buildDiagnosticReport` 的两次调用 `deepEqual`）。
3. **不把「重启所有服务」当通用修复策略。** `isSafeSuggestion()` 明确拒绝
   `重启所有服务` / `restart all services` / `systemctl restart all`。
4. **存储场景不扩大损失。** `rm -rf`、`mkfs`、`dd`、`mdadm --stop`、
   `重建阵列`、`停止存储服务`、`wipefs`、`fdisk`、`shred`、`truncate -s 0`
   一律判定为不安全；`buildDiagnosticReport` 产出的每一条 `nextSteps`
   在返回前都经过 `isSafeSuggestion()` 过滤。
5. **报告不泄露超量内容。** 证据 `detail` 截断到 200 字符，避免整段日志进报告。

## 5. 规则清单（根因候选）

| id | 分类 | 标题 |
| --- | --- | --- |
| `storage-disk-failure` | storage | 磁盘介质或控制器失效（SMART 报错 / IO 错误） |
| `storage-array-degraded` | storage | RAID 阵列降级 / 成员失效 |
| `storage-capacity-exhausted` | storage | 容量或 inode / 配额耗尽 |
| `storage-mount-failure` | storage | 文件系统挂载异常 / 只读重挂 |
| `network-dns-resolution` | network | DNS 解析失败 |
| `network-connectivity` | network | 网络不可达 / 路由缺失 |
| `network-port-unavailable` | network | 目标端口未监听 / 连接被拒 |
| `network-link-quality` | network | 链路质量劣化（丢包 / 协商速率下降） |
| `resource-memory-pressure` | resource | 内存压力 / OOM 触发进程被杀 |
| `resource-cpu-saturation` | resource | CPU 饱和 / 负载尖峰 |
| `resource-swap-thrashing` | resource | 交换分区抖动 |
| `permission-access-denied` | permission | 文件系统访问被拒绝 |
| `permission-authentication-failed` | permission | 鉴权失败 / 凭据无效 |
| `application-container-crash` | application | 容器反复崩溃 / 启动失败 |
| `application-image-missing` | application | 镜像缺失 / 标签不存在 |
| `application-service-crash` | application | 服务进程崩溃 / 异常退出 |
| `application-config-invalid` | application | 配置解析失败 / 配置漂移 |

其中 `storage-disk-failure` 与 `storage-array-degraded` 标记为需人工确认，
命中时 `escalation.required` 为 `true`。

## 6. 测试

```
node --test tests/phase-162-diagnostics.test.mjs
```

覆盖要点：

- 分类：存储 / SMART / 阵列 / IO 证据 → `storage`；网络、资源、权限、应用各归其类；
  空证据与不可判定证据 → `application` 且带 `reason`。
- 置信度：命中明确错误特征 → `confirmed`；同类证据 ≥ 2 → `likely`；
  仅弱信号 → `suspected`；**空证据不得给 `confirmed`**。
- 根因候选：`limit` 生效、排序按置信度稳定。
- 报告：`readOnlyChecks` 与 `nextSteps` 全部通过 `isSafeSuggestion()`，
  且不含删除 / 重建 / 格式化类动作；报告文本包含根因候选与置信度章节。
- `isSafeSuggestion`：`rm -rf /`、`mkfs`、`dd if=/dev/zero of=/dev/sda`、
  `mdadm --stop /dev/md0`、`重建阵列`、`停止存储服务`、`重启所有服务` 全部被拒；
  `smartctl -a /dev/sda` 等只读动作被接受。
- 纯函数性：模块源码不含第三方 import、I/O 与模型调用；相同输入输出相同。

## 7. 已知边界

1. 本阶段只做**基于已有证据**的静态推理，不主动采集证据；采集动作由调用方
   （未来的诊断编排层）按 `checks` 执行。
2. 规则表是有限枚举，未覆盖的厂商专有错误会落到 `suspected` 或
   "未匹配任何已知根因模式"，此时 `escalation.required` 为 `true`。
3. 分类采用加权词表，存在多类别同时命中时的并列取舍；本阶段按
   `DIAGNOSTIC_CATEGORIES` 顺序取先者，未做时序加权。
4. 本阶段不产出修复动作，`nextSteps` 中的处置一律留给后续的审批执行阶段。

## 8. 集成点建议（未在本阶段实施）

- 在 agent-core 收集到错误证据后调用 `classifyEvidence()` 得到分类，
  再调用 `rankCauses()` 得到候选，交给模型做**措辞**组织——判定本身始终由
  确定性规则负责，模型不得改写置信度。
- 报告渲染层直接使用 `buildDiagnosticReport().report` 文本，或按
  `causes` / `readOnlyChecks` / `nextSteps` 结构化渲染。
- 后续的自动修复阶段必须先过 `isSafeSuggestion()`：返回 `false` 的动作
  一律进入人工审批队列，不得自动执行。

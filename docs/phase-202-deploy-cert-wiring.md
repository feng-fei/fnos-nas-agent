# Phase 202 — 部署前校验、证书体检与幂等键接线

## 背景

Phase 198（证书体检）、Phase 199（幂等控制）、Phase 201（部署前校验）交付的都是纯函数层：
调用方把数据交进来，函数只做判定。这三层此前没有任何出口 —— 没有路由、没有界面，
也没有任何地方会真正用上幂等键。本阶段把它们接到 HTTP 上，并且只接到「没有副作用」
的位置：校验类接口可以被反复调用，不会因此部署任何东西或写入任何东西。

## 新增/变更代码

| 文件 | 变化 |
| --- | --- |
| `apps/fnos-nas-agent/app/server.mjs` | 新增 `POST /api/deploy/precheck`、`POST /api/network/certificate-check`；新增 `beginIdempotent` / `idempotentOutcome` / `rememberIdempotent` 三个小助手；审计路由名新增 `deploy.precheck`、`network.certificate-check` |
| `apps/fnos-nas-agent/app/idempotency.mjs` | Phase 199 交付，本阶段以 `maxRecords: 200` 实例化到 server 进程 |
| `apps/fnos-nas-agent/app/deployment-precheck.mjs` | Phase 201 交付，本阶段直接调用 |
| `apps/fnos-nas-agent/app/certificate-check.mjs` | Phase 198 交付，本阶段直接调用 |
| `tests/phase-202-http-routes.test.mjs` | 1 个真服务用例，覆盖鉴权、判定结论、幂等回放与冲突 |

## 两个接口

### `POST /api/deploy/precheck`

请求体 `{ plan, generate? }`，返回：

```json
{ "ok": true, "verdict": "ok|needs-review|blocked|unknown",
  "findings": [{ "code": "port-conflict", "severity": "block", "service": "worklog", "detail": "..." }],
  "serviceCount": 1, "notes": [] }
```

判定完全由 `precheckDeploymentPlan` 决定，server 只负责把结论透出去。注意两点：

- 结论是 `blocked` 时 HTTP 状态仍是 200 —— 这是「判定出来的问题」，不是接口出错；
  只有请求体连解析都过不去（例如 `precheckDeploymentPlan` 抛 `TypeError`）才返回 400。
- 这个接口**不会**执行部署，也不访问 Docker 或宿主；它只看调用方给的计划。

### `POST /api/network/certificate-check`

请求体 `{ record, hostname?, now?, warnDays? }`，返回：

```json
{ "ok": true, "verdict": "ok|expiring|expired|invalid|unknown",
  "summary": { "verdict": "ok", "daysRemaining": 214, "hostnameMatches": true, "notes": [] },
  "record": { "subject": "...", "issuer": "...", "notBefore": "...", "notAfter": "...", "parsed": true } }
```

- 证书由调用方交进来：本进程不做 TLS 握手、不读系统证书库，所以「没给/读不懂」只能是
  `unknown`，不会被说成 `ok`。
- `now` 没有默认值（纯函数层不读系统时钟），缺省时结论为 `unknown` + `now-missing`。
- `warnDays` 非法（0、负数、NaN、字符串等）会让纯函数抛 `TypeError`，接口转成 400。

## 幂等键

两个接口都接受可选请求头 `x-idempotency-key`：

| 情况 | 状态码 | 响应 |
| --- | --- | --- |
| 首次（键合法、请求体指纹一致） | 200 | 正常结果 |
| 重放（同键、同指纹，已完成） | 200 | 原结果 + `"replay": true` |
| 同键、不同请求体 | 409 | `code: "idempotency-conflict"` |
| 同键请求仍在执行 | 409 | `code: "idempotency-in-progress"` |
| 键非法（空、超长、含 `/` 空格等） | 400 | `code: "idempotency-invalid-key"` |
| 待重放结果超过 8 KiB | 200 | `{ ok: false, note: "result-too-large-to-replay" }` |

键缺失时完全不参与：不会替调用方去重，也不会因为没带键而报错。存储是进程内内存
（上限 200 条，LRU 淘汰已完成记录），重启即丢；这是刻意的最小实现 —— 这两个接口没有
副作用，重放的代价只是重算一次。

## 安全边界

1. 两个接口都要求登录会话、同源校验与 `application/json` 内容类型；未登录返回 401。
2. 请求体大小沿用既有 `jsonBody` 上限（16 KiB）。
3. 不执行任何命令、不发起任何网络请求、不写任何文件：全部判定都在纯函数里完成。
4. 审计只记录路由名与方法，不记录请求体（计划里可能有环境变量等敏感内容）。
5. 幂等存储不保存凭据：只保存判定结果快照，且超过 8 KiB 的结果拒绝回放而不是落盘。

## 测试结果

```text
node --test tests/phase-202-http-routes.test.mjs
# tests 1
# pass 1
# fail 0
```

用例内部依次断言：未登录 401；合规计划 `ok`；`privileged` 计划 `blocked` 且同时命中
`privileged-mode` / `privileged-port` / `writable-host-volume`；`generate: true` → `blocked`；
结构非法（`plan: 42`）→ 200 + `blocked`；同键重放 → `replay: true`；同键换体 → 409
`idempotency-conflict`；非法键 → 400；证书 `ok` / `expiring` / `expired` / 主机名不匹配
`invalid` / 缺记录 `unknown` / 缺 `now` `unknown` / `warnDays: 0` → 400。

同批次三个纯函数层的用例：Phase 198 `24/24`、Phase 199 `28/28`、Phase 201 `35/35`。

全量 `node --test`：**1493 tests / 1426 pass / 64 fail / 3 skipped**。64 项失败与本次改动前
逐条同名（Windows 环境限制：`0600` 文件模式、符号链接、FPK 打包），新增失败 0 项。

## 遗留

- 幂等存储是进程内内存，多实例部署时同一键可能各执行一次；要跨进程去重需要外部存储。
- 证书接口只做判定，不负责取证书：采集器（TLS 握手、失败重试、告警策略）尚未实现。
- 部署前校验不做 YAML/Compose 解析，也不比镜像 tag/digest；它只校验调用方已经结构化好的计划。
- 两个接口还没有 UI 入口：目前只能通过 API 调用；下一阶段再决定把它们放在哪张卡片上。

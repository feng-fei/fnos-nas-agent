# Phase 178 — 网络诊断（DNS / 网关 / 连通性 / 吞吐 / 证书 / 反代 / 升级）

## 背景

「服务连不上」是运维里最贵的一类问题：用户能看到的只有「打不开」，而失败可能发生在解析、路由、TCP、TLS、应用任一层。Marvis 的网络诊断入口值得借鉴的不是「自动修复」，而是**先定位到具体一层，再给一条只读的下一步**。本阶段把这一步落成一个不联网的纯函数模块。

## 新增代码

| 文件 | 说明 |
| --- | --- |
| `apps/fnos-nas-agent/app/network-diagnostics.mjs` | 9 个导出的纯函数，零 I/O、零 socket、零子进程 |
| `tests/phase-178-network-diagnostics.test.mjs` | 29 个用例 |
| `apps/fnos-nas-agent/app/server.mjs` | `GET/POST /api/network/diagnostics`，审计路由名 `network.diagnostics` |

## 导出 API

```js
diagnoseDns({ name, results, resolvers })        // → { status, stage, causes[], suggestions[], summary }
detectGateway({ routes, probes })                // → { gateway, reachable, candidates[], causes[] }
checkServiceConnectivity({ targets })            // → { targets[], causes[], summary{reachable,refused,timeout,unlistened,unknown} }
analyzeThroughput({ samples })                   // → { average, peak, jitter, idle, causes[] }
locateConnectionFailure({ stages })              // → { stage: resolve|route|tcp|tls|application|unknown, causes[] }
checkCertificate({ host, certificate, now })     // → { expiresInDays, expiringSoon, hostnameMatches, selfSigned }
inspectReverseProxy({ headers })                 // → { detected, headers[], missing[], causes[] }
checkUpgrade({ currentVersion, availableVersion })// → { updateAvailable, compatible, skips[] }
runConnectivityPatrol(input)                     // → { status, checks[], summary }
```

常量：`NETWORK_DIAGNOSTIC_CHECKS`、`CONFIDENCE_LEVELS`、`CERT_EXPIRY_WARNING_DAYS`（21 天）、`DEFAULT_PATROL_TIMEOUT_MS`、`MAX_TARGETS`（100）、`MAX_SAMPLES`（2000）、`MAX_THROUGHPUT_DRIFT`（0.35）、`READ_ONLY_SUGGESTIONS`。

## 语义

- **未测量即 `unknown`**。函数只分析调用方递进来的探测结果；没有数据时返回 `status: "unknown"`，绝不返回「正常」。巡检（`runConnectivityPatrol`）把每个未测项计入 `summary.unknownChecks`，整体状态为 `partial`。
- **结论分级**。每条 `cause` 带 `confidence`：`confirmed`（有直接证据，如 SERVFAIL、证书过期）、`likely`（间接证据，如多个解析器同时超时）、`suspected`（需要人工确认）。没有测量支撑的判断一律不进 `confirmed`。
- **拒绝 / 未监听要分开**。「端口主动拒绝」和「端口无响应」是两种故障：前者说明主机在线但服务没起，后者说明中间设备丢包或主机离线。`listening: false` 的拒绝会被改写为 `unlistened`。
- **建议只读**。`READ_ONLY_SUGGESTIONS` 里的命令全部是 `dig` / `ip` / `ss` / `openssl s_client` 这类只观察不改变状态的命令，测试用正则锁死，出现 `systemctl restart`、`iptables -A`、`rm` 等即失败。
- **越界输入被截断**。`MAX_TARGETS` / `MAX_SAMPLES` 超出时保留前 N 条，不抛错。

## 模块边界

`network-diagnostics.mjs` 不允许 import `node:net` / `node:dns` / `node:http` / `node:child_process` / `node:fs`，也不允许 `fetch(`；测试直接读源码断言。探测由调用方（运维脚本或既有工具）完成，本模块只做判定。

## HTTP 接口

```
GET  /api/network/diagnostics   → 巡检结果，所有未采集项为 unknown
POST /api/network/diagnostics   → 请求体是探测数据 { dns, gateway, service, throughput, connectivity, certificate, reverseProxy, upgrade }
```

POST 要求同源 + `Content-Type: application/json`；服务端自身不发起任何网络请求。

## 验证

```
node --test tests/phase-178-network-diagnostics.test.mjs   # 29 tests / 29 pass
node scripts/check-release-gates.mjs                       # exit 0
```

## 遗留

- 巡检的 `timeoutMs` 目前只是元数据，真正的超时由调用方控制。
- 证书检查接受已解析的证书字段（`notAfter` / `sanList` / `issuer`），没有内置 PEM 解析器；解析工作留给 `openssl` 输出或 Phase 175 的 web-fetch 证据。
- 清单对应项：N02 / N03 / N05 / N06 / N07 / N08 / N09 / N12 / O10。

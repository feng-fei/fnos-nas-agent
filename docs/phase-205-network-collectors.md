# Phase 205 — 网络采样的解析 / 增量 / 打包层

状态：**已完成**（仅数据层，未接线）
日期：2026-10-23
新增文件（3 个，未修改任何已有文件）：

- `apps/fnos-nas-agent/app/network-collectors.mjs`
- `tests/phase-205-network-collectors.test.mjs`
- `docs/phase-205-network-collectors.md`（本文）

## 背景

能力矩阵里 N03（网关判断）、N06（吞吐判断）、N09（反向代理识别）的状态是 **Partly**：
判定逻辑本身已经在 `apps/fnos-nas-agent/app/network-diagnostics.mjs` 里实现并有测试覆盖——

- `detectGateway(input)`：读 `routes` 与 `probes`，判断默认网关是否存在、是否可达；
- `analyzeThroughput(input)`：读 `samples`，判断空闲 / 正常 / 抖动；
- `inspectReverseProxy(input)`：读 `headers`，判断反向代理标记头是否齐全；
- `checkCertificate(input)`：证书判定（本 Phase 不涉及）。

这三项标 Open 的原因不是「判断不会做」，而是**没有真实采样输入**：`/proc/net/dev`、
`ip route`、nginx 配置的结构化视图都没有被解析和打包，判定函数在线上只能拿到空对象，
于是统一输出 `unknown`。Phase 205 只补「解析 → 增量 → 打包」这一层，把真实数据整理成
判定函数已经认识的入参形状；**判定仍然由 `network-diagnostics.mjs` 负责，本 Phase 不复制判断逻辑**。

## 导出

| 导出 | 入参 | 出参 | 说明 |
| --- | --- | --- | --- |
| `MAX_INTERFACES` | — | `64` | 单次快照最多接受的接口数，超出部分计入 `skipped` |
| `MIN_THROUGHPUT_WINDOW_MS` | — | `1000` | 吞吐速率的最小可信窗口，短于它直接判样本不足 |
| `parseProcNetDev(text)` | `/proc/net/dev` 原文 | `{ interfaces, skipped }` | 跳过表头、空行与 `lo`；残缺行整行跳过 |
| `diffInterfaceCounters(previous, current, { elapsedMs })` | 两份快照（数组或 `{ interfaces }`） | 差分数组 | 计数器回绕/变小时 `reset: true`，速率置 `null` |
| `parseRouteOutput(text)` | `ip route` 文本或 `ip -j route` JSON | `{ defaultGateway, defaultInterface, defaultMetric, routes }` | 无默认路由时 `default*` 全为 `null` |
| `buildGatewayInput({ route, ping })` | `parseRouteOutput` 的结果 + 可选探测 | `detectGateway` 的入参 | `ping = null` 时 `reachable` 为 `null`，**不伪造 `false`** |
| `buildThroughputInput({ diffs, windowMs })` | 差分数组 + 窗口毫秒 | `analyzeThroughput` 的入参 | 有效样本不足 2 个时返回 `{ samples: [], insufficient: true }` |
| `buildProxyInput({ config })` | nginx 风格的结构化对象 | `inspectReverseProxy` 的入参 | 只搬字段，**不解析 nginx 语法文本** |

`parseProcNetDev` 单个接口的形状：

```js
{
  name, rxBytes, txBytes, rxPackets, txPackets,
  rxErrors, txErrors, rxDropped, txDropped
}
```

`diffInterfaceCounters` 单条记录的形状：

```js
{
  name,
  rxBytesPerSecond, txBytesPerSecond,
  rxPacketsPerSecond, txPacketsPerSecond,
  droppedDelta, errorDelta,
  reset
}
```

## 输入格式假设

### 1. `/proc/net/dev`

假设是 Linux 常见的 16 列格式（接收 8 列 + 发送 8 列）：

```
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 111 2 0 0 0 0 0 0 111 2 0 0 0 0 0 0
  eth0: 1000 10 1 2 0 0 0 0 2000 20 3 4 0 0 0 0
```

- 取接收列 `0/1/2/3`（bytes / packets / errors / dropped）与发送列 `8/9/10/11`；
- 表头、空行、以及名字为 `lo` 的行直接跳过，不进入 `skipped`；
- 有冒号但列数不足 16、数字不是十进制非负整数、接口名为空或含空白、接口重名、
  超出 `MAX_INTERFACES` 的行：整行跳过并计入 `skipped`，**不会生成 `0` 占位**；
- 调用方负责读取文件；本模块不做任何文件访问。

### 2. `ip route`

文本形式（每行一条，认识 `via` / `dev` / `metric`，忽略 `proto/scope/src/...` 与
`nexthop` 续行）：

```
default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.100 metric 100
192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.100 metric 100
10.0.0.0/8 via 192.168.1.254 dev eth0 metric 200
```

JSON 形式（`ip -j route`）：

```json
[{"dst":"default","gateway":"192.168.1.1","dev":"eth0","metric":100}]
```

- 只对以 `[` 开头的文本尝试 `JSON.parse`，解析失败返回空结构，不抛异常；
- 文本行必须首 token 是路由类型词（`default`/`unicast`/`local`/...），且目标必须
  是 `default` 或包含 `.` / `:`，否则整行丢弃；
- `metric` 缺失记为 `null`；选择默认路由时缺失按 `0` 排序（与 `detectGateway` 一致）。

### 3. 探测（ping）与吞吐窗口

- 探测结果由**调用方**提供：可以是布尔值，或 `{ reachable, rttMs }`；只有
  `reachable` 是布尔值时才生成 `probes`，`rttMs` 不是有限非负数时写 `null`；
- 若调用方还没有探测结果，传 `ping = null`：`reachable` 保持 `null`。这一点必须
  严格，因为 `detectGateway` 的 `probe ? probe.reachable === true : null` 会把
  「存在但为 null」的 probe 误判成 `false`；
- 吞吐样本来自 `diffInterfaceCounters`：非 `reset` 且收发速率都有效的记录各产生
  一个 `rxBytesPerSecond + txBytesPerSecond` 样本；窗口 `windowMs` 必须 ≥
  `MIN_THROUGHPUT_WINDOW_MS`，否则视为样本不足。

### 4. nginx 配置（反向代理）

只接受**已经结构化的对象**，例如：

```js
{
  headers: { "X-Forwarded-For": "203.0.113.7" },
  upstreams: [{ name: "app", servers: ["127.0.0.1:3000", { address: "127.0.0.1:3001", weight: 3 }] }],
  servers: [{ listen: 443, serverName: "nas.local", ssl: true, locations: [{ path: "/", proxyPass: "http://app" }] }],
  locations: [{ path: "/api", proxyPass: "http://app/api" }]
}
```

- `upstreams`/`upstream`、`servers`/`server`、`locations`/`location` 两种键名都接受；
- 只搬 `listen`、`serverName`、`ssl`、`path`、`proxyPass`、`address`、`weight`、
  `backup` 等字段，缺省一律 `null`，不做语义推断；
- 头部证据可来自 `config.headers`（对象），或 `proxySetHeaders` / `proxy_set_header`
  的结构化条目（对象映射或 `[{ name|key, value }]`）；数组里的 nginx 原文
  （如 `"proxy_set_header X-Real-IP $remote_addr;"`）会被忽略；
- 完全没有任何结构化头部证据时 `headers` 为 `null` —— `inspectReverseProxy` 会
  返回 `unknown`（「不知道」），而不是编造「没有反代」；显式传 `headers: {}` 才会
  被当作「确认没有标记头」；
- location 内的头部**不会**向上合并到 server，避免把局部配置当全局证据。

## 安全边界

| 红线 | 具体做法 |
| --- | --- |
| **不采** | 模块零 `import`：不读 `/proc`、不读 nginx 配置、不做 DNS、不开 socket |
| **不执行** | 不调用 `child_process`、不执行 `ip`/`ping`/`nginx -T`，采样由调用方完成 |
| **不猜** | 数字非法一律 `null`（不补 `0`）；没有探测就 `reachable: null`；没有默认路由就 `defaultGateway: null` |
| **不臆造** | 不生成假样本、不把 `unknown` 降级成 `false`、不做「大概率如此」的填充 |
| **有上限** | 接口数受 `MAX_INTERFACES = 64` 限制，避免异常输入导致无界内存 |

以上红线由测试锁定：最后一个用例读取模块源码，断言不存在 `import` / `require(` /
`readFile` / `exec` / `spawn` 等调用，并断言注释中保留了这些约束。

## 测试

命令（在仓库根目录执行）：

```powershell
node --check apps/fnos-nas-agent/app/network-collectors.mjs
node --test tests/phase-205-network-collectors.test.mjs
```

结果：

| 检查 | 结果 |
| --- | --- |
| `node --check` | 通过（无输出） |
| `node --test` | **27 个用例 / 27 通过 / 0 失败 / 0 跳过** |

覆盖范围：

- `/proc/net/dev` 正常快照（`lo` 跳过，8 个计数器精确断言）、残缺行/非法数字/非法
  接口名整行跳过、重名只保留第一条、空输入与纯表头、`MAX_INTERFACES` 截断；
- 差分正常速率与 `dropped`/`error` 增量、计数器回绕 `reset`、`elapsedMs` 缺失 /
  `0` / 负数 / `NaN` / 字符串、无基线与非法主计数器、`{ interfaces }` 包装；
- `ip route` 文本、多默认路由取最小 `metric`、JSON 文本与已解析数组等价、无默认
  路由、空/坏 JSON/无关文本不抛异常；
- `buildGatewayInput` 的 `ping = null`、布尔 `ping`、`{ reachable, rttMs }`、缺少布尔
  `reachable` 四种情况，并用 `detectGateway` 验证最终 `reachable` 与 cause；
- `buildThroughputInput` 的样本汇总（交给 `analyzeThroughput` 得到 average/peak）、
  样本不足与窗口过短；
- `buildProxyInput` 的字段搬运、结构化头部被 `inspectReverseProxy` 识别为反代、
  nginx 原文被忽略、无头部证据返回 `unknown`、显式空对象返回未检测到；
- 常量、全空输入不抛异常、源码安全扫描。

## 遗留（交给 Lead）

1. **采样调度与接线**：本 Phase 只产出纯函数，没有任何定时器或文件读取。建议在
   `apps/fnos-nas-agent/app/server.mjs` 的 `/api/network/diagnostics` 里接线：
   - GET：调用方（server）读取 `/proc/net/dev` 与 `ip route` 后，把本次快照与上一次
     快照交给 `diffInterfaceCounters`（`elapsedMs = 本次采样时间 - 上次采样时间`），
     再 `buildThroughputInput({ diffs, windowMs: elapsedMs })`；路由走
     `parseRouteOutput` → `buildGatewayInput`；最后把结果传给已注入的
     `network-diagnostics`（`detectGateway` / `analyzeThroughput` /
     `inspectReverseProxy` / `checkCertificate`），替换当前全 `unknown` 的
     `runConnectivityPatrol({})`。首次采样没有基线时只记快照、返回 `unknown`，不要
     把「首帧」当成异常；
   - POST：可接受调用方交来的 ping 探测结果，转成 `buildGatewayInput` 的 `ping` 参数；
   - 采样频率需 ≥ `MIN_THROUGHPUT_WINDOW_MS`，否则吞吐判定会一直是样本不足。
2. **文档索引**：`tests/docs-links.test.mjs` 要求 `docs/README.md` 收录 `docs/` 下每个
   `.md`；本 Phase 按约束未修改任何已有文件，因此需要 Lead 在 `docs/README.md` 补一行
   指向本文，否则该测试会红。
3. **探测来源**：ICMP/TCP 探测（`ping` 的 `reachable`/`rttMs`）仍由调用方负责，本模块
   不执行、不解析探测输出。
4. **nginx 原文解析**：`nginx -T` 输出到结构化对象的转换器不在本期范围；先由部署侧
   或后续 Phase 提供对象，再交给 `buildProxyInput`。
5. **快照缓存与并发**：上一份快照的保存位置、过期策略、并发请求互斥，均属接线层，
   需要与 server 的生命周期一起设计。

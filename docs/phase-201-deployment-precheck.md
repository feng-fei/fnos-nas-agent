# Phase 201：部署前校验（纯函数层）

## 1. 背景

Phase 201 处理「部署前校验」：在真正把一份部署计划交给 Docker / Compose / 部署脚本之前，先判断这份计划是否值得执行。目标是先把判断逻辑独立出来，形成一层**纯函数**，既不改系统，也不依赖系统状态。

这一层只回答一个问题：**调用方手里的这份计划，能不能安全地进入下一步部署？** 它不负责：

- 不读文件、不读环境变量、不读 Docker socket；
- 不连 Docker、不连 registry、不发网络请求；
- 不解析 YAML / Compose 文件，不把文本转成计划；
- 不比较镜像版本，不解析 tag / digest；
- 不启动、不修改、不删除任何服务。

调用方（未来的 API route、CLI、UI 或部署编排器）负责把计划整理成普通 JavaScript 对象，再调用这里的函数。模块本身零 `import`、零 I/O、零第三方依赖，测试不需要 mock 文件系统或网络。

计划的基本形状：

```js
{
  services: [
    {
      name: "web",
      image: "nginx:1.27-alpine",
      user: "1000:1000",
      restart: "unless-stopped",
      ports: ["8080:80", "127.0.0.1:8443:443/tcp"],
      volumes: ["data:/data", "/srv/app:/app:ro"],
      env: ["TZ=Asia/Shanghai", "DB_PASSWORD=..."],
      privileged: false
    }
  ],
  generate: false,
  privileged: false
}
```

`services` 也可以是按服务名索引的对象表：

```js
{
  services: {
    web: { image: "nginx:latest", user: "1000", restart: "always" }
  }
}
```

## 2. 导出 API 与字段

模块路径：`apps/fnos-nas-agent/app/deployment-precheck.mjs`。

### 2.1 常量

| 导出 | 值 | 说明 |
| --- | --- | --- |
| `PRECHECK_SEVERITIES.BLOCK` | `"block"` | 阻止部署 |
| `PRECHECK_SEVERITIES.REVIEW` | `"review"` | 需要人确认 |
| `PRECHECK_SEVERITIES.INFO` | `"info"` | 提示，不影响结论 |
| `PRECHECK_VERDICTS.OK` | `"ok"` | 未发现需要处理的问题 |
| `PRECHECK_VERDICTS.NEEDS_REVIEW` | `"needs-review"` | 至少一条 `review`，无 `block` |
| `PRECHECK_VERDICTS.BLOCKED` | `"blocked"` | 至少一条 `block` |
| `PRECHECK_VERDICTS.UNKNOWN` | `"unknown"` | 计划结构合法但没有可检查的服务 |
| `MAX_SERVICES` | `50` | 单个计划的服务上限 |
| `MAX_PORTS` | `100` | 单个服务的端口映射上限 |
| `MAX_VOLUMES` | `100` | 单个服务的卷上限 |
| `MAX_ENV_ENTRIES` | `200` | 单个服务的 env 条目上限 |

`PRECHECK_SEVERITIES`、`PRECHECK_VERDICTS` 和额外导出的 `PRECHECK_CODES` 都是 `Object.freeze` 的常量对象。`PRECHECK_CODES` 集中列出全部稳定 finding code（见 2.3），方便调用方按字符串分支，避免在各处硬编码拼写。

### 2.2 函数

#### `validatePortMapping(value)`

```js
validatePortMapping(value: unknown): { host: number, container: number, protocol: "tcp" | "udp" } | null
```

解析一条端口映射。接受三种写法：

| 输入 | 结果 |
| --- | --- |
| `"8080:80"` | `{ host: 8080, container: 80, protocol: "tcp" }` |
| `"127.0.0.1:8080:80/udp"` | `{ host: 8080, container: 80, protocol: "udp" }` |
| `"[::1]:8080:80"` | `{ host: 8080, container: 80, protocol: "tcp" }` |
| `"0.0.0.0:1:65535"` | `{ host: 1, container: 65535, protocol: "tcp" }` |
| `"00080:0080"` | `{ host: 80, container: 80, protocol: "tcp" }`（5 位以内的前导零） |

端口必须是 `1..65535` 的整数；`host` 和 `container` 以 number 返回。协议只接受精确的小写 `tcp` / `udp`，省略时为 `tcp`。绑定地址只接受 IPv4 字面量（`127.0.0.1`、`0.0.0.0` 等）或方括号 IPv6 字面量（`[::1]`、`[::]` 等）；不接受 `localhost` 这类 DNS 名称。任何空白、控制字符、多余冒号/斜杠、越界端口、非字符串都返回 `null`。

此函数**不返回绑定地址**；需要判断「是否绑定到通配地址」的逻辑在 `precheckDeploymentPlan` 内部使用，避免把内部字段暴露成不稳定 API。

#### `findPortConflicts(plans)`

```js
findPortConflicts(plans: unknown): Array<{
  host: number,
  protocol: "tcp" | "udp",
  services: string[],
  severity: "block"
}>
```

找出同一个 `hostPort/protocol` 被两个以上**不同服务**占用的冲突。输入可以是一个计划、计划数组，或裸服务记录数组；计划里的 `services` 可以是数组或对象表。返回按 `host`、`protocol`、`services` 排序；`services` 内的服务名按 code unit 排序；每个冲突只返回一条，重复的端口声明会被集合去重。

比较只使用 `hostPort + protocol`，**故意忽略绑定地址**：`0.0.0.0:8080:80` 和 `127.0.0.1:8080:80` 也会被判为冲突。这是保守取舍，宁可多报 block，不放过潜在碰撞。同一个服务自己写两遍 `8080:80` 不算冲突。

非法端口条目会被跳过；此函数只负责冲突，不负责逐条报告的 `invalid-port`（那由 `precheckDeploymentPlan` 产出）。每个计划只取前 `MAX_SERVICES` 个服务，每个服务只取前 `MAX_PORTS` 条端口；输入为空数组或没有可用服务时返回 `[]`。

#### `validateVolumeSpec(value)`

```js
validateVolumeSpec(value: unknown): { hostPath: string, containerPath: string, mode: "ro" | "rw" } | null
```

解析一条卷映射。源以 `/` 或 `.` 开头时按**宿主机路径**处理，其余按**命名卷**处理：

| 输入 | 结果 |
| --- | --- |
| `"data:/data"` | `{ hostPath: "data", containerPath: "/data", mode: "rw" }` |
| `"/srv/app:/app:ro"` | `{ hostPath: "/srv/app", containerPath: "/app", mode: "ro" }` |
| `"./config:/config"` | `{ hostPath: "./config", containerPath: "/config", mode: "rw" }` |
| `"data:/data:rw"` | `null`（第三个字段只允许精确的 `ro`） |
| `"../x:/y:ro"` | `null`（宿主机路径含 `..` 段） |

规则：

- 容器路径必须以 `/` 开头，且不能含 `..` 段；
- 宿主机路径不能含空白/控制字符，也不能含 `..` 段；
- 命名卷必须匹配 `^[A-Za-z0-9][A-Za-z0-9_.-]*$`；
- 第三段只接受精确的 `ro`；省略即 `mode: "rw"`；显式 `rw`、`z`、`Z`、`cached` 等一律判非法；
- 只做字符串检查：不判断路径是否存在、是否有权限、是否在允许的根目录内。

#### `validateEnvEntry(value)`

```js
validateEnvEntry(value: unknown): { key: string, value: string } | null
```

解析一条 `KEY=VALUE`：

- 以第一个 `=` 分割，`value` 可以继续包含 `=`；
- `KEY` 必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`；
- `value` 可以为空；不 trim，前后空格原样返回；
- 没有 `=`、`KEY` 为空、`KEY` 非法、非字符串都返回 `null`。

#### `precheckDeploymentPlan(plan, options = {})`

```js
precheckDeploymentPlan(
  plan: unknown,
  options?: { generate?: boolean }
): {
  verdict: "ok" | "needs-review" | "blocked" | "unknown",
  findings: Array<{
    code: string,
    severity: "block" | "review" | "info",
    service: string | null,
    detail: string
  }>,
  serviceCount: number,
  notes: string[]
}
```

- `plan.services`：数组或对象表；数组元素/对象值必须是普通对象。
- 服务字段：`name`、`image`、`ports`、`volumes`、`env`、`user`、`restart`、`privileged`。
- `env` 可以是 `KEY=VALUE` 字符串数组，也可以是 `{ KEY: "VALUE" }` 对象；对象值必须是字符串。
- `plan.generate === true` 或 `options.generate === true`：计划本身要求生成模式，block。
- `plan.privileged === true` 或 `service.privileged === true`：block。
- `options` 不是对象时按 `{}` 处理，不抛异常。

返回字段：

| 字段 | 说明 |
| --- | --- |
| `verdict` | 见 2.4；任何 `block` 优先，其次 `review`，再次 `ok`，空计划为 `unknown` |
| `findings` | 已去重、按稳定顺序排序；`service` 为 `null` 表示计划级问题 |
| `serviceCount` | 计划声明的服务数量（超过上限时仍是真实数量，而不是截断后的 50） |
| `notes` | 非 finding 的说明；目前只有空计划的 `"no-services"` |

`findings` 的排序规则：先按 severity（block → review → info）；同 severity 内计划级（`service: null`）在前，再按服务名 code unit 排序，再按 code，再按 detail。重复项按 `severity|code|service|detail` 去重。所有 detail 最长 200 字符，服务名最长 120 字符，超出部分截断并追加 `...`；这样返回结果不会被超长名称撑爆。

### 2.3 稳定 finding code

| code | severity | 触发条件 |
| --- | --- | --- |
| `invalid-plan` | block | 计划不是普通对象；`services` 缺失/类型不对；服务条目不是对象 |
| `missing-image` | block | `image` 缺失、空串、全空白或非字符串 |
| `port-conflict` | block | 两个以上不同服务声明同一个 `hostPort/protocol` |
| `invalid-port` | review | 端口不是数组，或某条映射无法解析 |
| `privileged-port` | review | 宿主机端口 `< 1024` |
| `invalid-volume` | review | 卷不是数组，或某条映射无法解析 |
| `writable-host-volume` | review | 宿主机路径卷未声明 `:ro` |
| `invalid-env` | review | env 不是数组/对象，或某条 `KEY=VALUE`/对象键值非法 |
| `secret-in-env` | review | env key 命中疑似密钥正则且 value 非空 |
| `root-user` | review | `user` 缺失、空串、非字符串、非法数字，或解析为 root |
| `non-root-user` | info | 显式声明了非 root 用户 |
| `public-exposure` | review | 通配地址发布端口，且同时有可写宿主机卷或 privileged |
| `no-restart-policy` | info | `restart` 缺失、空串或非字符串 |
| `privileged-mode` | block | 计划级或服务级 `privileged: true` |
| `generate-mode` | block | 计划级或 options 的 `generate: true` |
| `too-many-services` | block | 服务数超过 `MAX_SERVICES` |
| `too-many-ports` | block | 单个服务端口数超过 `MAX_PORTS` |
| `too-many-volumes` | block | 单个服务卷数超过 `MAX_VOLUMES` |
| `too-many-env-entries` | block | 单个服务 env 条目数超过 `MAX_ENV_ENTRIES` |

### 2.4 结论汇总

| 条件 | verdict |
| --- | --- |
| 至少一条 `block` | `"blocked"` |
| 无 `block`，且计划结构合法但服务数为 0 | `"unknown"` |
| 无 `block`，至少一条 `review` | `"needs-review"` |
| 其余情况 | `"ok"` |

`info` 永远不会改变 verdict。一个完全合规但显式声明了非 root 用户的服务，会产生一条 `non-root-user` info，结论仍是 `ok`；这是有意的审计信息，不是噪音事故。

## 3. 语义与安全边界

### 3.1 判定顺序与「空计划」取舍

任务描述里同时出现了「无服务/结构非法 → blocked」和「若 plan 里没有任何服务对象，verdict = unknown 而非 blocked」，要求最终选择一个并写进文档。本实现的选择是：

- **结构非法**（plan 不是对象、`services` 缺失/类型错误、服务条目不是对象）→ `blocked` + `invalid-plan`；
- **结构合法但服务集合为空**（`services: []` 或 `services: {}`）→ `unknown` + `notes: ["no-services"]`，不产生 finding。

理由：结构非法说明调用方给的东西不是计划，必须 block；空计划说明「没有可检查的对象」，既不能证明安全（不能 `ok`），也不该冒充「计划本身危险」（不该 `blocked`）。`unknown` 让调用方必须显式决定「空计划要不要继续」，而不是被一个 block 或 ok 悄悄带过。若 Lead 希望空计划直接 block，只需在 `precheckDeploymentPlan` 的 `normalized.count === 0` 分支同时追加一条 block finding 并调整该分支的 verdict 计算；测试 `an empty but well-formed plan is unknown...` 会同步暴露这一改动。

### 3.2 端口语义

- `host` 是宿主机端口，`container` 是容器端口；只有宿主机端口参与「保留端口」判断。容器内监听 80 是常见做法，不应因为容器端口 80 而 review；宿主机绑定 80 才需要权限/人确认。
- 绑定地址严格只接受 IP 字面量。IPv4 做四段 0..255 的字符串检查；IPv6 只做「方括号内由十六进制和冒号组成」的宽松检查，不是完整 RFC 解析器。这是有意的：不引入 IPv6 解析依赖，也不假装做了完整校验。
- 端口冲突只比较 `hostPort/protocol`，忽略绑定地址；同一个服务重复声明同一端口不会和自己冲突。冲突 finding 的 `service` 为 `null`（跨服务问题），detail 里按排序列出参与的服务名。
- `findPortConflicts` 与 `precheckDeploymentPlan` 都按每个服务前 `MAX_PORTS` 条进行计算；超过上限时 `precheckDeploymentPlan` 另发 `too-many-ports` block。也就是说，超限计划的冲突结果只覆盖前 100 条，但计划已经被 block，不需要完整枚举。

### 3.3 卷语义

- 源以 `/` 或 `.` 开头视为宿主机路径；其他视为命名卷。这个分类是字符串规则，不需要访问文件系统。
- 命名卷允许字母数字开头，后续允许 `_`、`.`、`-`；不校验卷是否真实存在，也不校验 Docker 的完整命名规则。
- 宿主机路径只要没有空白/控制字符、没有 `..` 段就接受；不要求绝对路径（`./config` 也接受），不检查是否存在、是否可写、是否在某个白名单根目录内。
- 容器路径必须是绝对路径且不能含 `..`；不做符号链接解析。
- 第三个字段只接受 `ro`。显式 `:rw` 被当作非法而不是等价于默认的 `rw`：任务约定「mode 只在 `:ro` 时合法」，实现选择按字面执行，避免悄悄接受调用方写错的模式。代价是有些本可工作的计划会得到一条 `invalid-volume` review，需要调用方删掉 `:rw`。
- Compose 的长语法、`:z`/`:Z`/`:cached`/`:delegated` 等都不支持，会得到 `invalid-volume` review。

### 3.4 user、restart 与 env

- `user` 缺失/`null`/空串/全空白/非字符串/非法数字 → `root-user` review；`"root"`、`"0"`、`"0:0"`、`"00"`、数字 `0` → `root-user` review；其余显式值 → `non-root-user` info。
- 对 `user: ""`，任务里留了一个「记 note 还是记 finding」的开放点。本实现选择 **review finding**：空字符串没有声明任何非 root 身份，不能证明不会以 root 运行；note 太容易被忽略。若未来希望把它降级为 note，应同时修改文档和测试，不能只改实现。
- 只取第一个 `:` 前的用户部分判断 root；`1000:root` 视为非 root（组为 root 不改变用户身份），不解析数字 UID 与用户名的映射，也不解析 `/etc/passwd`。
- `restart` 缺失/`null`/空串/非字符串 → `no-restart-policy` info。不维护策略白名单：`always`、`unless-stopped`、`no`、`on-failure:5` 都算「已声明」，具体值是否合理不在本层判断。
- env 支持数组和对象两种形式；对象值必须是字符串，数字会得到 `invalid-env` review，而不是自动转成字符串。
- 疑似密钥规则：key 匹配 `/SECRET|TOKEN|PASSWORD|KEY/i` **且** value trim 后非空 → `secret-in-env` review。detail 只包含 key 名和「value is withheld」，绝不包含 value。非法 env 条目的 detail 也只写序号/键名，不 echo 原始字符串，因为原始字符串本身可能就是 `PASSWORD hunter2` 这类内容。
- 该正则只是启发式：`MONKEY` 会因为包含 `KEY` 被误报，`DB_PASS` 不会命中。误报只产生 review，不会 block；这是为「宁可多提醒」付出的代价。

### 3.5 「不猜」原则

本层明确不猜测以下内容：

- 不猜镜像是否存在、tag 是否有效、digest 是否匹配；不连 registry，不比较版本。当前没有任何版本输入，因此不会产生「版本不确定」的 finding；未来若加入版本比较，无法判定时必须返回 `unknown`，不能返回 `ok`。
- 不猜 YAML/Compose 的语义：不处理 anchor、merge key、重复 key、环境变量插值、`extends`、profile；调用方负责先完成解析。
- 不猜命名卷是否存在、宿主机路径是否可写、端口是否被计划外的进程占用；这些需要 Docker/主机状态，本层没有。
- 不猜服务名到 DNS/网络的映射，不检查依赖关系、健康检查、资源限制、镜像架构。
- 不自动修复：不补 `restart`、不补 `user`、不把 `:rw` 改成 `:ro`、不删端口、不重命名服务；只报告。
- 不把「缺字段」当成安全默认值：缺 `image` 是 block，缺 `user` 是 review，缺 `restart` 是 info。只有「没有服务」才走 `unknown`，而不是靠缺失字段推断。

### 3.6 安全边界

- **纯函数**：模块无 `import`、无 `require`、无 `process`、无 `fetch`、无文件/网络/子进程；不读环境变量，不写全局状态。测试中有一条源码纯度断言，防止未来误引入 I/O。
- **不修改入参**：`precheckDeploymentPlan` 和 `findPortConflicts` 只读计划对象，不写回、不排序入参数组、不删除字段；测试用 `structuredClone` 快照验证。
- **不泄漏密钥值**：`secret-in-env` 和 `invalid-env` 的 detail 都不包含 env 的 value 或原始条目。注意 key 名本身会出现在结果中，调用方仍应把结果当成可能含敏感命名的数据。
- **有界输出**：detail 200 字符、服务名 120 字符；服务/端口/卷/env 的校验数量有上限。超过上限时先发 block，再只校验前 N 条，避免为一个已经不可部署的计划做无界工作。
- **输入规模**：模块对单个超长字符串仍会做正则和切分；不承诺对恶意超大输入做 CPU/内存隔离。计划对象被视为调用方信任的普通数据；带 getter 的奇异对象可能触发 getter，本层不做防御。
- **不是安全审计**：不检查镜像 CVE、不检查容器逃逸配置、不检查网络策略、不检查宿主机防火墙；`public-exposure` 只是「通配端口 + 可写宿主机卷/privileged」的启发式 review，不能替代网络暴露审计。

### 3.7 语义取舍

| 取舍点 | 选择 | 理由 |
| --- | --- | --- |
| 空且合法的计划 | `unknown` + note，不 block 不 ok | 区分「输入非法」与「没有可检查对象」；避免把空计划误判为安全 |
| 结构非法 | `blocked` + `invalid-plan` | 不是计划就不能进入部署 |
| `user: ""` | `root-user` review | 空字符串没有声明非 root 身份；note 太容易忽略 |
| 显式非 root | `non-root-user` info | 可审计，但不改变 ok 结论 |
| 端口冲突 | 忽略绑定地址 | 保守，宁可误报 block，不放过潜在碰撞 |
| 宿主机端口 < 1024 | review | 需要特权/端口占用确认；容器端口不判断 |
| 卷第三段 | 只接受 `ro`，显式 `rw` 非法 | 按任务「mode 只在 `:ro` 时合法」的字面语义，不替调用方猜 |
| 可写宿主机卷 | review | 宿主机文件暴露给容器，需要人确认 |
| 命名卷 | 不触发可写宿主机卷 review | 命名卷由 Docker 管理，不直接对应宿主机路径 |
| 公开暴露 | 通配端口 +（可写宿主机卷或 privileged）才 review | 范围窄，避免对每个 published port 都刷 review；loopback 不报 |
| 密钥启发式 | 子串正则，只 review | 误报代价低；无法穷举真实密钥命名 |
| 超限 | block + 只校验前 N 条 | 已不可部署，不做无界枚举 |
| 排序 | code unit，不按 locale | 稳定、可复现，不受运行环境语言影响 |
| 额外导出 `PRECHECK_CODES` | 导出并冻结 | 调用方需要按 code 分支；集中定义避免拼写漂移 |

## 4. 测试结果

测试文件：`tests/phase-201-deployment-precheck.test.mjs`，使用 `node:test` + `node:assert/strict`，不 mock 文件系统/网络。

执行命令（本机 Node v22.22.0）：

```powershell
node --check apps/fnos-nas-agent/app/deployment-precheck.mjs
node --check tests/phase-201-deployment-precheck.test.mjs
node --test tests/phase-201-deployment-precheck.test.mjs
```

三个命令均通过；测试的 TAP 汇总（一次真实运行）：

```text
1..35
# tests 35
# suites 0
# pass 35
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 203.9145
```

35 个用例覆盖：

- 常量值、冻结、`MAX_*` 数值；
- 端口三种写法、前导零、边界 1/65535、非法协议/空白/DNS 主机/IPv6 括号错误；
- 冲突去重、忽略绑定地址、同服务自冲突、tcp/udp 分开、单计划/裸服务输入；
- 命名卷与宿主机路径、`:ro`/显式 `:rw`、`..` 越界、容器路径非绝对、空白；
- env 解析、空值、value 含 `=`、非法 KEY；
- 空计划 `unknown`、非法计划 `blocked`、非对象服务条目；
- 缺 image、privileged、generate（plan 与 options 两处）、缺 restart；
- host 端口 80/1023/1024、容器端口 80 不误报、非法端口；
- 可写宿主机卷/命名卷/只读卷/非法卷；
- user 缺失、空串、root、`0:0`、`00`、数字 0、非 root 字符串与数字；
- secret-in-env 命中且 detail 不含 value、空值不命中、对象 env、invalid-env 不回显原始条目；
- public-exposure 的通配/loopback、命名卷、只读卷、IPv6、privileged 组合；
- 对象表服务与 serviceCount；
- 四个上限的「恰好允许」与「多一条 block」；
- findings 去重/稳定排序、计划不被修改、模块源码纯度。

新增文档本身会影响 `tests/docs-links.test.mjs`：该测试要求 `docs/` 下每个 `.md` 都出现在 `docs/README.md` 的链接里。本次任务明确不修改 `docs/README.md`，因此全量测试会在该测试上失败。实际运行 `node --test tests/docs-links.test.mjs` 时，失败列表为：

```text
every document must be listed in docs/README.md: phase-198-certificate-check.md, phase-199-idempotency.md, phase-201-deployment-precheck.md
```

其中 `phase-198-certificate-check.md` 和 `phase-199-idempotency.md` 来自本次并行派发的其他子任务，不是本任务创建的文件；`phase-201-deployment-precheck.md` 是本任务新增的。具体处理建议见 5.1。

## 5. 遗留

1. **`docs/README.md` 尚未收录本文档（以及并行子任务的 198/199 文档）**。当前 `node --test tests/docs-links.test.mjs` 的 `docs/README.md lists every document in docs/` 用例失败信息是：`every document must be listed in docs/README.md: phase-198-certificate-check.md, phase-199-idempotency.md, phase-201-deployment-precheck.md`。本任务按约束只新建 3 个文件、不改既有文件、不改 README；198/199 两条不在本任务范围。需要 Lead 统一补 `docs/README.md` 索引后消除。
2. **未接线**。本阶段只交付纯函数层：没有 API route、CLI、UI、部署编排器调用；没有读取真实计划来源。调用方仍需决定空计划（`unknown`）是否允许继续，以及 `needs-review` 是否需要人工审批。
3. **没有 YAML/Compose 解析**。计划对象由调用方构造；anchor、merge key、重复 key、变量插值、`extends`、profile 等语义不在本层。若未来从 Compose 文件导入，需要单独的解析层和对应的「解析失败」错误路径。
4. **没有镜像/版本/registry 校验**。不检查 image 是否存在、tag 是否可变、digest 是否固定；没有版本比较，因此目前不会出现「版本不确定 → unknown」的分支。未来加入版本字段时，无法判定必须走 `unknown`，不能默认 `ok`。
5. **没有 Docker/主机状态**。无法发现宿主机端口已被计划外进程占用、命名卷不存在、宿主机路径无权限、Docker daemon 不可用；这些需要执行层或独立探测，不应塞进纯函数层。
6. **卷检查仅字符串级**。不解析符号链接、不检查路径是否在允许根目录内、不支持 Compose 长语法与 `:z`/`:Z`/`:cached` 等模式；这些会得到 `invalid-volume` review。
7. **user 语义简化**。只判断第一个 `:` 前的名字/数字；不解析 UID/GID 映射，不查 `/etc/passwd`，不判断组 root；`1000:root` 会被视为非 root。若需要更严格的用户策略，应新增显式配置，而不是在本层猜。
8. **密钥启发式有限**。`/SECRET|TOKEN|PASSWORD|KEY/i` 会漏掉 `DB_PASS`，也会误报 `MONKEY`；误报只 review，漏报可能放过敏感值。后续可考虑可配置的 key 规则/允许列表，但要避免把 value 写进日志。
9. **性能未基准**。上限保证结果有界，但单个超长字符串的扫描成本未测量；计划对象被视为可信输入。
10. **环境差异**。`package.json` 声明 `node >= 26`，本机为 Node v22.22.0；本模块没有使用 26 专有 API，测试在 22 上通过，但 CI 目标版本仍以仓库声明为准。
11. **没有端到端用例**。未用未来的 API/CLI 真实计划跑过；当前测试全部是直接调用纯函数。

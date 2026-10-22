# Phase 164 — MCP 服务端

本阶段实现清单模块 14「技能系统与 MCP 扩展」中的 **SK10：MCP 服务端** —— 把
NAS 的安全只读能力提供给兼容的 MCP 客户端。

腾讯 Marvis 桌面端以 MCP（stdio JSON-RPC）接入外部工具；本仓库此前已经有
MCP **客户端**（`app/mcp-client.mjs`，Phase 148）与 MCP **工具桥接层**
（`app/mcp-tool-bridge.mjs`，Phase 153），但缺少反向的一端。本阶段补上这一端：
NAS 自身可以作为 MCP **服务端**，让 Claude Desktop、Marvis 或任意兼容宿主
通过 stdio 调用 NAS 的只读能力。

传输方式是与 MCP 生态命令行一致的方式：**stdio 上的换行分隔 JSON-RPC 2.0**。

## 1. 背景与对照

| 事实 | 证据 | 本阶段对应实现 |
| --- | --- | --- |
| Marvis 以 MCP stdio JSON-RPC 接工具 | Marvis 逆向报告 `C:\Users\Administrator\.dsh\ungrouped\reports\marvis-ui-report.md`；安装目录 `MarvisMCP.exe`、`AndrowsMCP.exe`、`GameInfoMCP.exe` | `toStdioTransport()` 按行读写 JSON-RPC 2.0 |
| 本仓库已有 MCP 客户端 | `app/mcp-client.mjs`（`initialize` → `notifications/initialized` → `tools/list` → `tools/call`） | 服务端实现完全对称的方法集，`protocolVersion` 与客户端握手一致 |
| 工具桥接层把外部工具并入本地目录 | `app/mcp-tool-bridge.mjs`，工具 id 形如 `mcp__server__tool` | 外部工具名与内部工具 id 分离：`files.list` → `files_list` |
| 只读工具已有独立注册表 | `app/read-only-tools.mjs`，每个工具带 `risk: "read-only" \| "write" \| "destructive"` | 服务端只发布 `risk === "read-only"` 的条目 |
| 清单条目 SK10 | `docs/marvis-feature-checklist.md:418`「SK10 MCP 服务端：把安全暴露的 NAS 能力提供给兼容客户端」 | 本阶段即该条目的实现 |

## 2. 变更边界

本阶段**只新增**三个文件：

| 文件 | 作用 |
| --- | --- |
| `apps/fnos-nas-agent/app/mcp-server.mjs` | MCP 服务端实现；零依赖 ESM，不读取任何环境变量，不监听端口 |
| `tests/phase-164-mcp-server.test.mjs` | `node --test` 用例（23 个） |
| `docs/phase-164-mcp-server.md` | 本文档 |

明确**没有**发生的事：

- 没有修改 `app/server.mjs`、`app/mcp-client.mjs`、`app/mcp-tool-bridge.mjs`、
  `app/read-only-tools.mjs`、`app/tool-registry.mjs`、`app/execution-policy.mjs`
  或任何其它既有模块；
- 没有修改 `app/ui/` 下的任何文件；
- 没有新增 HTTP 路由、没有监听任何 TCP/UDP 端口；
- 没有修改 `model-providers.json` 或任何持久化格式；
- 没有修改 `README.md`、`docs/README.md`、`scripts/check-release-gates.mjs`；
- 没有执行 `git commit`。

## 3. 导出 API 约定

```js
import {
  createMcpServer,
  toStdioTransport,
  redactToolResult,
  externalToolName,
  maskSecret
} from "./mcp-server.mjs";
```

| 导出 | 签名 | 返回 | 说明 |
| --- | --- | --- | --- |
| `createMcpServer` | `({name?, version?, tools?, invoke?, maxBytes?}) => {handle, handleLine, listTools, close, ...}` | 服务端对象 | 见下方方法表 |
| `toStdioTransport` | `(server, {input?, output?}) => {start, stop, isRunning}` | 传输控制器 | 逐行读 `input`、逐行写 `output`；测试中不启动真实进程 |
| `redactToolResult` | `(text: unknown) => string` | 脱敏后的文本 | 对疑似密钥做掩码；普通文本原样返回 |
| `externalToolName` | `(tool: object) => string` | 外部工具名 | 优先用工具自带的 `name`；否则把内部 id `files.list` 改写为 `files_list` |
| `maskSecret` | `(value: unknown) => string` | 掩码字符串 | 与 `app/security-audit.mjs` 语义一致：只留前 2 位，后接 8 个 `*` |

### 3.1 方法表

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `initialize` | — | `{protocolVersion:"2024-11-05", capabilities:{tools:{}}, serverInfo:{name,version}}` |
| `notifications/initialized` | — | `null`（通知不回复） |
| `tools/list` | — | `{tools:[{name, description, inputSchema}]}` |
| `tools/call` | `{name, arguments}` | `{content:[{type:"text",text}], isError?}` |
| `ping` | — | `{}` |
| 其它 | — | JSON-RPC 错误 `-32601` |

错误码：`-32700` 解析失败、`-32602` 参数非法（含调用未暴露的工具）、
`-32601` 未知方法、`-32603` 服务端内部错误。

### 3.2 输出格式

- 每个响应是**单行 JSON**（`JSON.stringify` 后不含裸换行）；
- 超过 `maxBytes`（默认 1 MiB）的 `tools/call` 响应被截断为
  `{content:[{type:"text",text:"[结果过大，已截断]"}], truncated:true}`；
- `tools/call` 中工具自身抛错时返回 `{content:[...], isError:true}`，而不是
  传输层错误——错误是工具的事实，不该让客户端误以为连接坏了。

## 4. 只读暴露策略

1. **只发布 `risk === "read-only"` 的工具。** `write` 与 `destructive` 条目
   不出现在 `tools/list`，也不会被调用。
2. **调用未暴露的工具返回 `-32602`**，message 明确写明「未被本服务端暴露：
   MCP 服务端只发布只读工具」，并在 `error.data` 附带 `{tool, exposed:false}`。
3. **服务端不自批。** 没有 `approved` 参数、没有 capability 参数、没有
   「先调用再审批」的路径；客户端在 `tools/call` 里塞 `approved:true` 也不会
   被读取。客户端无法用自己的参数买通一次写操作。
4. **风险等级未知即不可暴露。** 一个 `risk` 不是 `read-only`/`write`/
   `destructive` 的条目按最保守处理（不可暴露），不按默认只读处理。
5. **工具名与内部 id 分离。** 内部标识符 `files.list` 属于 agent 的命名空间
   （工具目录用点号分隔），对外发布为 `files_list`，避免宿主把 MCP 名与内部
   id 混为一谈。同名工具以先出现者为准，后出现者不会遮蔽前者。

## 5. 边界声明

> **只读暴露是暴露面（exposure surface），不是安全边界（security boundary）。**

真正的边界由既有模块承担：

- `app/read-only-tools.mjs`：只读工具本身的参数校验、路径白名单、
  结果截断与敏感文件跳过；
- `app/execution-policy.mjs`：全局执行策略（只读模式、kill switch）；
- `app/execution-capability.mjs`：破坏性操作所需的服务端签发凭据；
- `app/audit-log.mjs` / `app/tool-call-observer.mjs`：调用留痕。

本模块的作用只是**缩小暴露面**：即使调用方绕开本模块直接使用内部注册表，
上述边界依然生效。反过来，本模块也不能被当作「因为只读所以安全」的证明——
一个被误标为 `read-only` 的工具仍然会被本模块发布，这正是风险标注必须准确
的原因。

## 6. 安全设计

1. **密钥掩码。** `redactToolResult()` 覆盖三类模式：`sk-…` 形式的 API Key、
   `Bearer <token>`、以及 `api_key=` / `"password":` 等键值对；掩码后只保留
   前 2 位，与 `app/security-audit.mjs` 的 `maskSecret` 语义一致。
2. **双向脱敏。** 掩码同时作用于成功的工具结果和失败时的错误文案，避免
   「异常信息里带出密钥」这条常见泄漏路径。
3. **不落盘。** 本模块不读写任何文件、不缓存密钥、不打日志。
4. **不监听端口。** 只有 stdio 传输，没有 TCP 监听，因此不会新增网络攻击面。
5. **错误信息不外泄栈。** 工具抛出的异常只取 `message`，不带栈信息。

## 7. 测试清单

```bash
node --test tests/phase-164-mcp-server.test.mjs
```

共 23 个用例，全部通过（`# pass 23 / # fail 0`）：

| # | 用例 | 覆盖点 |
| --- | --- | --- |
| 1 | initialize reports the protocol version, the server info and the tool capability | 握手结果 |
| 2 | notifications/initialized is answered with null | 通知不回复 |
| 3 | tools/list publishes only the read-only tools | 只读过滤 |
| 4 | tools/call runs a read-only tool and returns a text content block | 正常调用 |
| 5 | tools/call on a write tool is refused and the tool never runs | 写工具被拒且不执行 |
| 6 | tools/call on a destructive tool is refused as well | 破坏性工具被拒 |
| 7 | an unknown method is answered with -32601 | 未知方法 |
| 8 | a broken JSON line is answered with -32700 | 解析失败 |
| 9 | a malformed tools/call request is answered with -32602 | 参数非法 |
| 10 | an oversized result is truncated instead of being sent | 超长截断 |
| 11 | a failing tool is reported as a tool error, not as a transport error | `isError` 语义 |
| 12 | redactToolResult masks a secret but keeps the surrounding text | 脱敏（键值对） |
| 13 | redactToolResult masks a bearer token and a JSON style secret | 脱敏（Bearer / JSON） |
| 14 | redactToolResult leaves an ordinary result untouched | 普通文本不变 |
| 15 | a tool result that contains a secret is masked before it leaves the server | 结果出口脱敏 |
| 16 | maskSecret keeps only the first two characters | 掩码语义 |
| 17 | externalToolName rewrites the internal identifier and keeps a declared name | 命名空间分离 |
| 18 | the server refuses to expose a tool whose risk is unknown | 未知风险不暴露 |
| 19 | the server never approves a call on behalf of the client | 不自批 |
| 20 | the stdio transport answers every line with a single line of JSON | 单行输出 |
| 21 | the stdio transport refuses a broken line with a parse error | 传输层解析失败 |
| 22 | a closed server refuses further requests | 关闭后拒绝 |
| 23 | listTools mirrors tools/list | 两个入口一致 |

测试全部在进程内使用 `EventEmitter` 模拟 stdio，**不启动任何子进程**。

## 8. 集成说明

本阶段**没有**接入主服务。以下为后续集成步骤（由集成方完成）：

1. **提供命令行入口。** 新增一个薄入口脚本，例如
   `apps/fnos-nas-agent/bin/mcp-server.mjs`：用
   `createReadOnlyToolRegistry()`（`app/read-only-tools.mjs`）拿到目录，
   把 `list()` 的结果作为 `tools` 传入，`invoke` 转发到该注册表的
   `invoke(id, args)`；然后 `toStdioTransport(server).start()`。
2. **注册到宿主配置。** 客户端侧在 MCP 配置里加一条
   `{command: "node", args: ["<abs>/bin/mcp-server.mjs"]}`；
   Marvis 的对应位置是其 MCP 服务注册表（MarvisMCP.exe / AndrowsMCP.exe）。
3. **目录来源。** `tools` 传入的是 `read-only-tools.mjs` 的 `list()` 结果；
   它已经带有 `risk` 字段，天然满足「只发布只读」的要求。
4. **审计。** 若要满足 SK11（工具调用审计），在 `invoke` 包装层里调用
   `app/tool-call-observer.mjs`，而不是改本模块。
5. **不要**在本模块里加审批或 capability 参数；审批属于内层注册表与执行策略
   的职责。

## 9. 后续建议

1. 增加一个 `tools/call` 的参数 schema 预校验（目前参数合法性由内层
   `read-only-tools.mjs` 判定，服务端只做形状检查）。
2. 为 `toStdioTransport` 增加写端背压处理，避免宿主消费慢时缓冲无限增长。
3. 增加 `resources/list`、`prompts/list` 的空实现，便于对宿主声明能力边界。
4. 把 `maxBytes` 提到配置层，与 `app/execution-policy.mjs` 的响应上限统一。
5. 在 `docs/marvis-capability-matrix.md` 中把 SK10 标记为 Implemented。

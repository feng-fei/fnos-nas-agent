# Phase 153 — MCP tool bridge

## 1. The problem

Phase 147 introduced the tool registry, Phase 148 the MCP client. Between them
there was a gap: the registry expects a **source** with a `list()` and an
`invoke()`, and the MCP client speaks the protocol but knows nothing about the
safety rules of this project. A tool of a foreign server therefore had no
place where its risk was decided and no place where the global execution
policy was applied.

The gap was a real hole, not only a wiring detail:

* a server publishes any name it wants, so a tool called `list_volumes` may in
  reality remove a volume;
* an unknown name must never be treated as harmless, because the server
  controls the name;
* the error of a server can contain a token, an API key or the value of an
  environment variable of the Agent.

## 2. What this phase adds

`apps/fnos-nas-agent/app/mcp-tool-bridge.mjs` is the piece in between. It
turns the tools of one MCP server into registry compatible descriptors and it
keeps the rules of the project intact while a foreign tool runs.

```js
import { createMcpToolBridge, listBridgedTools, unregisterServer } from "./mcp-tool-bridge.mjs";

const bridge = createMcpToolBridge({
  client,          // the client of `mcp-client.mjs`
  tools,           // the catalogue the client published
  policy,          // the global execution policy
  prefix: "mcp",   // the identifier prefix
  requestApproval  // asks for a one time approval
});

bridge.listBridgedTools();  // [{ id, title, description, risk, inputSchema, server }]
bridge.get(id);
bridge.invoke(id, args, options);
bridge.unregisterServer(serverName);
bridge.toToolSource();      // a source for the tool registry of Phase 147
```

`listBridgedTools()` and `unregisterServer()` also exist as module level
functions. They work on every bridge of the process, so a caller that owns one
bridge does not need a registry of its own:

```js
listBridgedTools();            // the tools of every bridge
listBridgedTools(bridge);      // the tools of one bridge
unregisterServer("nas");       // remove the server from every bridge
unregisterServer("nas", bridge);
```

## 3. The exported API

| Export | Signature | Role |
| --- | --- | --- |
| `createMcpToolBridge` | `createMcpToolBridge({ client, tools, policy, prefix = "mcp", requestApproval, serverName, timeoutMs, secrets })` | Creates the bridge of one or more servers. |
| `listBridgedTools` | `listBridgedTools(bridge = null)` | The bridged tools of one bridge or of all of them. |
| `unregisterServer` | `unregisterServer(serverName, bridge = null)` | Removes a server and returns the number of removed tools. |
| `mapMcpToolRisk` | `mapMcpToolRisk(tool)` | Decides the risk of one raw tool description. |
| `mcpBridgeToolId` | `mcpBridgeToolId(serverName, toolName, prefix = "mcp")` | Builds the namespaced identifier. |
| `normalizeMcpSegment` | `normalizeMcpSegment(value)` | Normalizes one segment of an identifier. |
| `splitMcpToolName` | `splitMcpToolName(name)` | Splits a name into its words. |

The constants of the module:

```js
export const MCP_BRIDGE_ID_PREFIX = "mcp";
export const MCP_BRIDGE_ID_SEPARATOR = "__";
export const MAX_BRIDGE_DESCRIPTION_LENGTH = 500;
export const MAX_BRIDGE_TOOLS_PER_SERVER = 200;
export const MAX_BRIDGE_SERVERS = 16;
export const DEFAULT_BRIDGE_TIMEOUT_MS = 20_000;
```

## 4. The identifier namespace

A bridged tool never shares an identifier with a built-in one:

```js
mcpBridgeToolId("nas", "list_volumes");   // "mcp__nas__list_volumes"
```

Every character that is not a lower case letter, a digit or an underscore
becomes an underscore, the result is never empty. A server or a tool whose
name normalizes to nothing is **not** bridged: it is reported in the `rejected`
list of `registerServer()` and it is skipped.

## 5. The risk mapping

The risk of a tool is decided by its **name** and by an explicit read-only
marker of the server. A declared risk of the server is not trusted, because the
server controls the name.

| Name | Risk |
| --- | --- |
| `get_volume`, `list_volumes`, `search_content`, `status` | `read-only` |
| `create_snapshot`, `update_volume`, `set_status` | `write` |
| `delete_snapshot`, `search_and_delete`, `run_command` | `destructive` |
| `wibble` (unknown) | `destructive` |
| any name with `readOnly: true`, `readOnlyHint: true` or `annotations.readOnly` | `read-only` |

Three rules make the mapping safe:

* **A destructive verb wins over everything.** `search_and_delete` is
  destructive, never read-only, even when the server marks the tool as
  read-only.
* **A write verb wins over a read verb.** `set_status` is a write, not a read.
* **An unknown name is destructive.** There is no "unknown means harmless"
  default.

The verbs are matched as words, so `getVolume`, `get_volume` and
`volume.list` are all understood. A word that executes something (`run`,
`exec`, `execute`, `start`, `stop`, `restart`, `sync`) is destructive, not a
mere write.

## 6. The rules the bridge keeps

* **The global execution policy applies to every bridged tool.** The read-only
  mode and the kill switch cover a tool of a server exactly like a built-in
  tool. A verdict of the policy that is not `allowed` refuses the call and the
  reason is reported.
* **A write or a destructive tool needs an explicit one time approval.** The
  bridge asks `requestApproval` before such a call. Without an approval flow
  the call is refused, it is never executed. The approval request carries the
  identifier, the server, the name, the risk and the title of the tool, so the
  confirmation dialog of the UI can describe the call.
* **The policy is checked again after the approval.** An approval never
  overrides the read-only mode or the kill switch.
* **A call is bounded.** One call has a timeout (20 s by default). A server that
  does not answer is reported as a `timeout`, the call is abandoned.
* **A failing server never breaks the Agent.** Every failure is a structured
  result, not an exception:

  ```js
  { ok: false, error: { code, message } }
  ```

  The codes are `tool-not-found`, `client-unavailable`, `approval-denied`,
  `policy-unavailable`, `policy-denied`, `read-only-mode`, `kill-switch`,
  `unknown-risk`, `timeout`, `protocol-error` and `server-error`.
* **An error message never carries a secret.** The message of a server is
  redacted before it reaches the caller: an explicit secret, a value of a
  sensitive environment variable, a `sk-`/`ghp_` token, a `Bearer` header, a
  `token=`/`api_key=`/`password=` pair and a long hex blob are replaced with
  `已隐藏`. The message is bounded to 500 characters.
* **A server is registered once.** Registering the same server again replaces
  its catalogue instead of adding to it, so a reconnect never doubles the tools.
* **A broken schema degrades, it does not break the catalogue.** A tool that
  publishes no usable schema is bridged with an empty schema and the
  description says so.

## 7. The description

Every bridged tool carries the origin of its server in front of its
description, and the whole text is bounded:

```js
"[mcp:nas] 列出存储卷。"
```

## 8. Known limits

* **The identifier of a bridged tool is not yet accepted by the registry.**
  `tool-registry.mjs` validates an identifier with
  `/^[a-z0-9][a-z0-9._:-]{0,127}$/`, which does not contain the underscore.
  The `mcp__server__tool` namespace of this phase therefore needs one more
  character in that pattern (`_` has to be added to the character class), or the
  registry has to use the `mcp:<server>:<tool>` form of `mcp-client.mjs`. Until
  that is done, the tools of a bridge are listed by the bridge itself and are
  not visible in `registry.list()`.
* **The result of a tool is not validated.** The bridge forwards the result of
  a server unchanged. A tool that returns more than the transport allows is
  already bounded by the client of Phase 148.
* **The bridge is a runtime catalogue.** A server is registered when the
  process starts and it is gone when the process stops. The configuration and
  the lifecycle of the servers live in `mcp-servers.mjs` (Phase 148).

## 9. Files

| File | Role |
| --- | --- |
| `apps/fnos-nas-agent/app/mcp-tool-bridge.mjs` | The bridge itself. |
| `tests/phase-153-mcp-tool-bridge.test.mjs` | Behaviour and safety rules. |
| `apps/fnos-nas-agent/app/server.mjs` | Wires the bridge into the tool registry (integration). |

## 10. The lines that must not break

* No arbitrary execution: the bridge never starts a process, never writes a
  file and never executes a tool of a server on its own. It only describes and
  forwards.
* A foreign tool never bypasses the global execution policy.
* A write or destructive tool of a server needs an explicit one time approval.
* An unknown name is destructive.
* An error message never carries a secret.

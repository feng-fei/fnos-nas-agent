# Phase 148 — MCP client

## 1. The problem

Marvis talks to its tools through **MCP** (Model Context Protocol) servers. The
reverse engineering of the Marvis installation showed that it ships four MCP
executables and configures them per server, and that a single server that
fails never blocks the built-in tools of the application.

The fnOS Agent had no way to speak that protocol: the tool catalogue was the
built-in list only, so a server that an operator wanted to add was impossible.

## 2. What this phase adds

Two modules, both written without a third party dependency, so the NAS image
does not need a build step:

* `apps/fnos-nas-agent/app/mcp-client.mjs` — a JSON-RPC 2.0 client over the
  **stdio** transport, which is the transport the MCP servers of Marvis use as
  well.
* `apps/fnos-nas-agent/app/mcp-servers.mjs` — the configuration file
  (`mcp-servers.json` inside the data directory of the Agent) and the
  lifecycle of the servers.

## 3. The exported API

```js
import { createMcpClient, createMcpSource, mcpToolId, validateMcpServerConfig } from "./mcp-client.mjs";
import { createMcpManager, parseMcpConfig, readMcpConfig } from "./mcp-servers.mjs";

const client = createMcpClient({ server, timeoutMs: 20_000 });
await client.start();                    // spawn the process, send `initialize`
const tools = await client.listTools();  // the catalogue of the server
await client.callTool("name", { args }); // invoke one tool
client.close();                         // terminate the process
```

The protocol version is pinned:

```js
export const MCP_PROTOCOL_VERSION = "2024-11-05";
```

A tool of a server is namespaced, so it can never collide with a built-in
tool:

```js
mcpToolId(serverId, toolName);   // "mcp:<serverId>:<toolName>"
```

`createMcpSource()` turns a client into a source of the tool registry of
Phase 147.

## 4. The rules the client keeps

* **A server is never started on its own.** It has to be declared in the MCP
  configuration file and it has to be explicitly enabled. The configuration is
  read on start and it is never written by the Agent.
* **A server without a declared risk is treated as `write`.** The risk is
  declared per server in `mcp-servers.json` and it is attached to every tool
  the server publishes. There is no "unknown means harmless" default.
* **The global execution policy applies.** A tool of a server is evaluated by
  the same execution policy as a built-in tool, so a `destructive` tool of a
  server still needs an explicit confirmation.
* **The process is bounded.** One request has a timeout (20 s by default), the
  answer of a server is bounded (1 MiB) and the buffer of the transport is
  bounded (8 MiB). A server that floods the pipe is closed instead of
  exhausting the memory of the NAS.
* **A failing server never blocks the built-in tools.** The servers are
  contacted once at start. A server that does not answer is reported in
  `GET /api/mcp/status`, and the Agent keeps working with the tools it has.
* **The environment of the server is explicit.** The declared environment
  variables are validated, an invalid name or a non string value refuses the
  whole entry.

## 5. The configuration file

```json
{
  "servers": [
    {
      "id": "files",
      "label": "File tools",
      "command": "/usr/bin/python3",
      "args": ["/opt/mcp/files.py"],
      "risk": "read-only",
      "enabled": true,
      "env": {}
    }
  ]
}
```

The file lives in the data directory of the Agent (`mcp-servers.json`) and is
read once at start.

## 6. Known limits

* Only the **stdio** transport is implemented. HTTP and SSE transports of MCP
  are not supported.
* The client does not implement the sampling and the roots capability of the
  protocol. The Agent is a client of tools, it does not let a server call
  back into it.
* A server that needs a secret gets it through the declared environment
  variables of its own entry. The Agent never writes a secret into the MCP
  configuration.

## 7. Files

| File | Role |
| --- | --- |
| `apps/fnos-nas-agent/app/mcp-client.mjs` | The protocol client. |
| `apps/fnos-nas-agent/app/mcp-servers.mjs` | The configuration and the lifecycle. |
| `tests/phase-148-mcp-client.test.mjs` | Protocol, validation and safety rules. |
| `apps/fnos-nas-agent/app/server.mjs` | Wires the servers into the tool registry and exposes `GET /api/mcp/status`. |

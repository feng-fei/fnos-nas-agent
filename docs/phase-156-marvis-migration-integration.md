# Phase 156 — Marvis migration integration

## 1. The problem

The migration was executed phase by phase, and every phase kept its own
document. That left a reviewer without a single place that answers the
question the whole round was about: **which Marvis capability is now part of
this repository, where does it live, and which rule keeps it safe?**

This phase writes that map down. It does not add a feature, it does not
change a line of runtime code and it does not change a test. It is the
integration record of the round: the mapping table, the naming and risk
rules of the MCP bridge, the red lines that survived the migration, and the
limits that are still open.

## 2. Mapping table: Marvis capability → this repository

| Marvis capability | Implementation in this repository | Phase | Path |
| --- | --- | --- | --- |
| Skill package format, size and entry limits, manifest bounds | `skill-package.mjs` — package parser with `MAX_PACKAGE_BYTES`, `MAX_PACKAGE_ENTRIES`, `MAX_PACKAGE_UNCOMPRESSED_BYTES`, per-file limits | 144 | `apps/fnos-nas-agent/app/skill-package.mjs` |
| Dangerous command rule pack, four severities, three rule scopes | `dangerous-command-rules.mjs` — `DANGEROUS_COMMAND_SEVERITIES` (`block`/`warn`/`review`/`info`), `DANGEROUS_COMMAND_RULE_SCOPES` (`command`/`source-review`/`manifest`) | 145 | `apps/fnos-nas-agent/app/dangerous-command-rules.mjs` |
| Tool call trace (what the agent did, how long, what failed) | `tool-trace.mjs` — `createToolTracer()`, fixed error vocabulary, append-only `tool-trace.jsonl` | 146 | `apps/fnos-nas-agent/app/tool-trace.mjs` |
| Tool call observer wired into the real call sites | `tool-call-observer.mjs` — `createToolCallObserver()`, `OBSERVER_STATUSES` (`ok`/`error`/`denied`/`timeout`), redaction of secrets | 146 | `apps/fnos-nas-agent/app/tool-call-observer.mjs` |
| Task event stream (live progress of a running task) | `task-manager.mjs` — `subscribe()` / `publicTask()` | 146 | `apps/fnos-nas-agent/app/task-manager.mjs` |
| Registrable tool registry with one source model | `tool-registry.mjs` — `createToolRegistry()`, `TOOL_SOURCE_KINDS` (`builtin`/`skill`/`mcp`), `normalizeToolId()` | 147 | `apps/fnos-nas-agent/app/tool-registry.mjs` |
| MCP client (JSON-RPC over stdio, no dependency) | `mcp-client.mjs` — `createMcpClient()`, `MCP_PROTOCOL_VERSION = "2024-11-05"` | 148 | `apps/fnos-nas-agent/app/mcp-client.mjs` |
| MCP server configuration file and lifecycle | `mcp-servers.mjs` — `parseMcpConfig()`, `readMcpConfig()` (`mcp-servers.json` in the data directory), `createMcpManager()` | 148 | `apps/fnos-nas-agent/app/mcp-servers.mjs` |
| MCP tool bridge (foreign tools become registry tools) | `mcp-tool-bridge.mjs` — `createMcpToolBridge()`, `mcpBridgeToolId()`, `mapMcpToolRisk()` | 153 | `apps/fnos-nas-agent/app/mcp-tool-bridge.mjs` |
| Marvis-style conversation window | chat window with bubbles, tool cards, inline approval, stop button and streamed progress | 149 | `docs/phase-149-chat-window.md` |
| Dual-mode chat window (task mode / direct chat) | the same window with a mode switch; the direct mode answers with plain text instead of creating a NAS task | 151 | `docs/phase-151-chat-direct-mode.md` |
| Direct chat channel (server side) | `model-chat-adapter.mjs` — `createModelChatAdapter()` with `chat()` and `status()`; routes `POST /api/chat/message` and `GET /api/chat/status` | 150 / 151 | `apps/fnos-nas-agent/app/model-chat-adapter.mjs`, `apps/fnos-nas-agent/app/server.mjs` |
| Marvis-style model management surface | `model-settings.js` / `model-settings.css`, wired in `pages.js`; field level validation and a two step wizard | 154 | `apps/fnos-nas-agent/app/ui/model-settings.js`, `apps/fnos-nas-agent/app/ui/model-settings.css` |

## 3. The MCP bridge: identifier namespace

A tool of a foreign server never enters the registry under its own name. The
bridge namespaces it:

```
mcp__<server>__<tool>
```

* `MCP_BRIDGE_ID_PREFIX = "mcp"`, `MCP_BRIDGE_ID_SEPARATOR = "__"` — the
  separator is doubled, so a server name and a tool name that contain a
  single underscore cannot be confused with each other.
* The server segment and the tool segment are normalized
  (`normalizeMcpSegment()`); the whole identifier is matched by
  `normalizeToolId()` of the registry, so an identifier of a foreign server
  can never collide with a built-in tool id.
* Limits that keep one server from flooding the registry:
  `MAX_BRIDGE_SERVERS = 16`, `MAX_BRIDGE_TOOLS_PER_SERVER = 200`,
  `MAX_BRIDGE_DESCRIPTION_LENGTH = 500`, `DEFAULT_BRIDGE_TIMEOUT_MS = 20_000`.

## 4. The MCP bridge: risk mapping rules

The risk of a bridged tool is decided by `mapMcpToolRisk()` and only by the
**name** of the tool and an explicit read-only marker. A risk that the server
itself declares is not trusted, because a server controls its own names.

1. A name that contains a destructive verb is `destructive` — always, and
   before every other check. `search_and_delete` is never read-only, and
   `run_command` is never a mere write.
2. A server that marks the tool read-only (`readOnly`, `readOnlyHint` or
   `annotations.readOnly`) is `read-only`.
3. A name with a write verb (`create`, `update`, `set`, `upload`, `move`,
   `chmod`, …) is `write`.
4. A name with a read verb (`get`, `list`, `read`, `search`, `query`,
   `status`, …) is `read-only`.
5. **A name that matches neither is `destructive`.** An unknown name is
   never treated as harmless.

The name is matched as a whole and on its last segment, so `get_volume` and
`volume.list` are both recognized. The three levels are
`read-only` / `write` / `destructive` (`RISK_LEVELS`).

## 5. Safety red lines of the migrated round

These rules are the reason the migration is allowed to exist at all. They
hold for a built-in tool, a Skill tool and a foreign MCP tool alike.

* **Unknown means dangerous.** A tool whose name cannot be classified is
  `destructive`; it needs an explicit one time approval.
* **A foreign tool must bring its own capability.** The bridge refuses a
  tool whose server did not hand out a capability object; a server cannot
  mint an approval, the approval is minted inside the server of this
  application.
* **The global switch covers external tools.** The execution modes of
  `execution-policy.mjs` are `normal`, `read-only` and `halted`. In
  `read-only` every mutating tool is refused, in `halted` nothing runs at
  all — not even a read. A bridged MCP tool is bound by the same modes; the
  bridge does not get an exception.
* **A write or destructive tool needs a one time approval.** Without an
  approval flow the call is refused instead of being executed.
* **Secrets are never shown, only fingerprinted.** The provider key is
  stored encrypted and the UI shows a fingerprint (`sha256:` + 8 hex
  characters) that is derived from `{hasKey, keyFingerprint, lastTestAt,
  lastTestOk}`. The clear value never comes back to the browser while it is
  edited, and the credential state of the UI is derived from those fields
  only.
* **Errors are structured and redacted.** A trace entry and an observer entry
  carry a fixed status and error vocabulary; a raw upstream body, a stack
  trace or a token never reaches the caller.

## 6. Known limitations

* **The MCP server configuration is not wired into the workspace.** The
  server reads `mcp-servers.json` from the data directory at startup
  (`readMcpConfig()`), and the repository does not ship a worked example of
  that file. A fresh installation therefore starts with an empty MCP
  configuration; a server has to be written into the data directory by
  hand. The parser and the manager are in place and are covered by tests,
  the example is not.
* **The wizard of the model settings UI is a client side hint.** The
  validation of the fields, the credential state and the fingerprint are
  real, but the steps of the wizard are rendered by the browser; the server
  does not keep a wizard state, and a step that is skipped on the client
  side is not recorded anywhere.
* **The status of an MCP server is reported, not repaired.** A server that
  does not answer at startup is listed in `GET /api/mcp/status` and never
  blocks the built-in tools, but the agent does not restart a broken server
  on its own.
* **The trace is written next to the data, not into the audit trail.** The
  audit log keeps task metadata, the tool trace is an append-only
  `tool-trace.jsonl` with its own vocabulary; the two are not joined yet.
* **The risk mapping reads names.** A server that publishes a harmless name
  for a harmful tool is misclassified as read-only. The rule "unknown is
  destructive" limits the damage, it does not remove it. The only reliable
  answer for a server is the approval flow.

## 7. Verification

* `node scripts/check-release-gates.mjs` — the readiness gates, including the
  index count sentence and the per phase record checks.
* `node --test tests/docs-links.test.mjs` — every document of the directory
  is indexed and linked.
* The per phase tests of the migrated phases (144–155) are the proof of the
  individual pieces; this document only maps them.

This phase adds no runtime code and no test. The mapping table is the
deliverable, and it is checked by the release gates like every other record.

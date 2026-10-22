# Security Model

## Defaults

- Bind the web server to loopback by default during development. LAN binding must be an explicit deployment setting.
- Require authentication before exposing NAS information or actions.
- Use a per-install random secret or a supported fnOS authentication integration; never ship a default password.
- Do not expose the management UI directly to the public internet.
- Do not store NAS passwords in the Agent.
- Never log API keys, OAuth access/refresh tokens, cookies, authorization headers, or full secret-bearing command lines.
- Do not enable unrestricted root access as a convenience feature.

## Risk tiers

### Tier 0 — local deterministic operations

Examples: show Agent version, show enabled Skills, display task history metadata. No NAS mutation.

### Tier 1 — read-only NAS queries

Examples: system information, application list, container list, selected logs. Allow only after authentication, schema validation, and output redaction.

### Tier 2 — reversible service operations

Examples: start, stop, or restart a known service/container. Require a confirmation that names the target and exact action.

### Tier 3 — destructive or broad mutations

Examples: delete files, remove apps, modify network/storage/users, bulk changes, execute arbitrary scripts. Deny by default in v0.1. If ever added, require a separate explicit policy decision and strong confirmation.

## Approval requirements

A confirmation is bound to:
- the specific task and tool call;
- the exact validated arguments;
- the current user session;
- a short expiry;
- a single execution.

Any change to the arguments invalidates the approval. Replaying an approval must not execute the operation twice.

## Command execution

- Use a fixed executable path and `spawn`/equivalent with an argument array.
- Never use `shell: true` for model-controlled values.
- Validate tool names and every argument against a schema and allowlist.
- Set execution timeouts, output byte limits, and concurrency limits.
- Do not accept executable paths, environment overrides, or raw command strings from the model.
- Treat CLI output as untrusted data; it may contain secrets or terminal control sequences.

## Skill package safety

- Imported packages start in a quarantine/pending-review state.
- Parse metadata as data; never evaluate JavaScript, shell, or lifecycle hooks during import or review.
- Reject path traversal, symlinks escaping the package root, duplicate normalized paths, oversized files, and unexpected executable files.
- Record package origin, version, content hash, review status, and requested capabilities.
- Enabling a Skill does not grant it permissions.
- Only the built-in adapter may execute tools in v0.1; Skill instructions alone never create executable tools.
- Updates are staged and reviewed before replacing an enabled version.
- Disabling a Skill prevents new dispatches immediately.

## OAuth and secrets

The official fnOS Skill documentation describes an OAuth 2.0 Authorization Code + PKCE flow. The adapter must follow the exact supported flow and must not collect a NAS password or bypass interactive authorization. The exact token storage and refresh behavior must be confirmed against the supplied official package before implementation.

## Audit trail

Record timestamp, user/session identifier, Skill ID/version, tool name, risk tier, approval status, duration, and outcome. Redact arguments that may contain secrets or personal data. Do not store full file contents or unbounded raw logs by default.

## Incident controls

Provide a global read-only mode and a kill switch that blocks all mutating tool calls. A Skill can be disabled without stopping the core web UI. Errors fail closed: unknown tool, malformed arguments, expired approval, missing auth, or policy uncertainty means no execution.

Implemented in [Phase 126 — Execution Policy](phase-126-execution-policy.md), [Phase 127 — Destructive Capability](phase-127-destructive-capability.md), and [Phase 131 — Server hardening](phase-131-server-hardening.md):

- The execution policy has three modes: `normal`, `read-only` and `halted`. The mode comes from `<AGENT_DATA_DIR>/execution-mode.json` first, from `AGENT_EXECUTION_MODE` second, and from the default last.
- `read-only` refuses every write and destructive tool call; `halted` refuses every tool call and answers `503`.
- An operator flips the mode from the mobile console or through `GET`/`POST /api/execution-mode`. The endpoint is deliberately not gated by the policy, so the kill switch can always be lifted again.
- A destructive tool call is never executed directly. The server returns `202` with an approval record, and the grant is bound to the session that requested it; another session cannot confirm or deny it.
- The delete capability is a module-private symbol that never reaches the browser, so a client cannot forge the explicit confirmation.
- First-run setup requires an installation code for any caller that is not on the appliance itself.

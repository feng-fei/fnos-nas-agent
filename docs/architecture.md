# Architecture

## Project goal

Build a small, self-hosted fnOS NAS Agent distributed as an FPK. The first release prioritizes a mobile-friendly LAN web console, low-token task routing, and tightly controlled access to NAS operations.

The Agent is independent of any single LLM or Agent framework. Skills are optional capability packages, not the runtime itself.

## Runtime components

1. **Web UI** — mobile-first chat, task progress, tool result summaries, and explicit approval prompts.
2. **HTTP/API server** — serves the UI and exposes authenticated local endpoints.
3. **Agent coordinator** — classifies requests, creates bounded plans, tracks task state, and summarizes results.
4. **Tool registry** — exposes only registered, schema-validated tools to the coordinator/model.
5. **Policy engine** — evaluates each proposed action before execution.
6. **Skill manager** — imports, inspects, enables, disables, and removes Skill packages.
7. **fnOS adapter** — invokes explicitly supported `trim-cli` operations through a fixed argument interface.
8. **Model adapter** — optional remote model API; secrets are held server-side and redacted from logs.
9. **FPK lifecycle integration** — install/start/stop/upgrade/uninstall integration is implemented and covered by a CI smoke test on the bundled runtime (see docs/phase-117 and docs/phase-123); real fnOS device acceptance remains a manual staging gate.

## Trust boundaries

- User browser -> HTTP server: authenticated session, CSRF protections for state-changing requests, bounded request sizes.
- Model -> tool registry: model output is untrusted data. It cannot invoke arbitrary shell commands or choose executable paths.
- Skill package -> Skill manager: package content is untrusted until reviewed. A Skill cannot install itself, grant permissions, or execute during import.
- Agent -> fnOS adapter: only allowlisted operations and typed arguments are accepted.
- Adapter -> trim-cli: executable path is fixed by configuration; arguments are passed as an array, never through shell interpolation.
- Logs -> UI: secrets, authorization headers, tokens, and sensitive file contents must be redacted.

## Execution flow

1. Authenticate the user.
2. Route deterministic read-only requests without an LLM when a safe rule matches.
3. For ambiguous tasks, ask the configured model for a bounded structured plan.
4. Validate the plan against registered tool schemas.
5. Evaluate each proposed tool call with the policy engine.
6. If confirmation is required, display the exact operation and arguments and wait for approval.
7. Execute with timeout/output limits; capture a redacted result.
8. Summarize results and persist minimal task metadata.

## Resource principles

- Node.js native runtime; no database server or container is required for the first version.
- Prefer built-in Node.js modules and avoid runtime dependencies unless justified.
- Bound concurrency, request size, output size, plan length, and task duration.
- Do not run a local model by default on the J4125 host.
- Do not collect periodic telemetry unless explicitly enabled.

## Non-goals for v0.1

- Arbitrary shell access through chat.
- Automatic privilege escalation.
- Unreviewed third-party Skill execution.
- Autonomous installation/uninstallation of packages.
- Remote access exposed to the public internet by default.
- Destructive file or storage operations without explicit approval.

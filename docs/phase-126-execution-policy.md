# Phase 126 — Execution policy: global read-only mode and kill switch

## 1. What this phase adds

`apps/fnos-nas-agent/app/execution-policy.mjs` introduces a single, server-side
decision point for "may this tool call run right now?". It closes the gap
described in `docs/security.md:72`:

> Provide a global read-only mode and a kill switch that blocks all mutating
> tool calls.

Until now nothing in `apps/fnos-nas-agent/app/` implemented that property — the
phrase existed only in the documentation. This module provides it, and it is
wired into the tool registry (`apps/fnos-nas-agent/app/read-only-tools.mjs`) so
that the decision is actually enforced on the execution path.

## 2. The three modes

| Mode | Meaning | Read-only tools | Write tools | Destructive tools |
| --- | --- | --- | --- | --- |
| `normal` | Default. Writes are allowed; destructive calls need a one-shot server approval. | allowed | allowed | only with an approval capability |
| `read-only` | Service stays up and answers reads, but every mutating call is refused. | allowed | refused (403) | refused (403) |
| `halted` | Kill switch. The service keeps running (the web UI stays reachable) but **no** tool call is executed, not even a read. | refused (503) | refused (503) | refused (503) |

`halted` deliberately does not stop the process: the operator must still be
able to reach the UI to flip the mode back, and the service must stay
restartable by an operator rather than by an attacker.

## 3. Configuration and precedence

The effective mode is resolved with this precedence (highest first):

1. **State file** — `<dataDir>/execution-mode.json`
2. **Environment variable** — `AGENT_EXECUTION_MODE`
3. **Default** — `normal`

### 3.1 State file format

```json
{ "mode": "read-only", "updatedAt": "2026-10-22T10:00:00.000Z" }
```

The file lives next to the other server state (sessions, password record,
audit log) in `AGENT_DATA_DIR`. It is written atomically (temporary file +
`rename`) with mode `0600`.

### 3.2 Environment variable

`AGENT_EXECUTION_MODE=normal|read-only|halted` — useful for container
deployments and for the systemd unit, where no writable data directory is
available. It is read at process start and on every `reload()`.

### 3.3 Fail-closed behaviour of the resolver

* A corrupt state file (invalid JSON) is **ignored**, one line is printed to
  the console (`[execution-policy] Ignoring ...`) and the next precedence level
  is used.
* A state file or environment variable carrying an unsupported mode is ignored
  the same way.
* The resolver **never throws**; a broken control file must never be able to
  take the service down, and it must never silently promote itself to a
  permissive mode either — an unusable state file simply falls back to the
  next source.

## 4. Decision matrix (`evaluate`)

`evaluate({ risk, approved })` is synchronous and returns
`{ allowed, reason, requiresApproval, statusCode }`.

| `risk` | `mode` | `approved` | result | `reason` | `statusCode` |
| --- | --- | --- | --- | --- | --- |
| `read-only` | `normal` / `read-only` | – | allowed | `allowed` | 200 |
| `read-only` | `halted` | – | refused | `kill-switch` | 503 |
| `write` | `normal` | – | allowed | `allowed` | 200 |
| `write` | `read-only` | – | refused | `read-only-mode` | 403 |
| `write` | `halted` | – | refused | `kill-switch` | 503 |
| `destructive` | `normal` | `true` | allowed | `allowed` | 200 |
| `destructive` | `normal` | not `true` | refused | `approval-required` | 409 |
| `destructive` | `read-only` | `true` | refused | `read-only-mode` | 403 |
| `destructive` | `halted` | `true` | refused | `kill-switch` | 503 |
| anything else / missing | any | – | refused | `unknown-risk` | 403 |

Notes:

* `approved` must be the boolean `true`. `"true"`, `1`, `"yes"` and every other
  truthy value count as **not** approved — an approval is a fact, not a
  string.
* An unknown or missing `risk` level is refused with `unknown-risk` and HTTP
  403. This is the "policy uncertainty means no execution" rule from
  `docs/security.md:72`.
* `requiresApproval` is `true` only for the `approval-required` verdict, i.e.
  when the call is destructive, the service is in `normal` mode, and no
  approval has been granted yet.

## 5. API

```js
import { createExecutionPolicy, EXECUTION_MODES } from "../app/execution-policy.mjs";

const policy = createExecutionPolicy({ dataDir: process.env.AGENT_DATA_DIR });

policy.mode();      // "normal" | "read-only" | "halted"
policy.source();    // "default" | "environment" | "state-file"
policy.evaluate({ risk: "write" });     // { allowed, reason, requiresApproval, statusCode }
await policy.setMode("read-only");      // { mode: "read-only", source: "state-file" }
await policy.reload();                  // re-read the state file
```

`setMode(mode)` throws a `TypeError` synchronously for a mode outside
`EXECUTION_MODES`; when the state directory does not exist the returned promise
rejects with an error carrying `statusCode === 500` and the in-memory mode is
left untouched.

Zero third-party dependencies: only `node:fs/promises`, `node:path` and
`node:crypto` are used.

## 6. Where it is enforced

`apps/fnos-nas-agent/app/read-only-tools.mjs` evaluates the policy for **every**
invocation, in this order:

1. argument validation (schema, `additionalProperties: false`, bounds);
2. `executionPolicy.evaluate({ risk, approved })`;
3. the destructive-tool capability check.

The registry is the single entry point used by the agent loop
(`apps/fnos-nas-agent/app/agent-core.mjs`), by the HTTP tool runner and by the
approval service, so a mode change applies to all of them at once. When no
policy instance is supplied the registry keeps its previous behaviour (the
capability check alone), which keeps the module usable in unit tests.

## 7. Relation to `docs/security.md`

| `docs/security.md` requirement | Status after this phase |
| --- | --- |
| Global read-only mode | implemented (`read-only` mode) |
| Kill switch that blocks all mutating tool calls | implemented (`halted` mode; blocks reads as well, which is stricter) |
| A Skill can be disabled without stopping the core web UI | unchanged — the mode is a policy decision, not a process exit |
| Unknown tool / malformed arguments / expired approval / missing auth / policy uncertainty ⇒ no execution | enforced at the registry (`unknown-risk`, `approval-required`) and at the file manager (see `docs/phase-127-destructive-capability.md`) |

## 8. Operator runbook

```sh
# One-shot switch to read-only (the state file is the persistent source)
node -e 'import("./apps/fnos-nas-agent/app/execution-policy.mjs").then(async m => {
  const p = m.createExecutionPolicy({ dataDir: process.env.AGENT_DATA_DIR });
  console.log(await p.setMode("read-only"));
})'

# Emergency kill switch
# ... setMode("halted")

# Back to normal
# ... setMode("normal")
```

Read back the effective state with `policy.mode()` / `policy.source()`, or
simply look at `<dataDir>/execution-mode.json`.

## 9. Tests

`tests/phase-126-execution-policy.test.mjs` covers the mode constants, the
full decision matrix, the precedence order, the fail-closed handling of a
corrupt state file, `setMode` persistence and its rejection of an unknown mode.

# Phase 131 — Server hardening: setup code, policy surface and session-bound approvals

Phase 126 and 127 introduced the execution policy and the destructive capability token.
Phase 131 wires that policy into every HTTP entry point, closes the first-run setup race
described in `docs/security.md`, and makes the running service report the state it is in.

## 1. One version, one source

`apps/fnos-nas-agent/app/version.mjs` is now the single source of truth:

```js
export const APP_VERSION = "0.2.1";
```

The FPK manifest (`apps/fnos-nas-agent/manifest`), the npm package metadata
(`package.json`) and the runtime (`GET /api/health`) all report the same value. Before
this phase the manifest and the package said `0.1.0` while `/api/health` hard-coded
`0.2.1`, so an installed appliance and its own health endpoint disagreed.

`tests/phase-131-server-hardening.test.mjs` asserts that the three values cannot drift
apart again.

## 2. First-run setup requires an installation code

`POST /api/setup` used to be reachable by any host on the same LAN. A device that was
already on the network could therefore claim an unconfigured instance before its owner
ever opened the console.

The service now writes a one-time installation code to
`<AGENT_DATA_DIR>/setup-code.txt` (mode `0600`) when no password is configured yet and
prints it once to the log:

```
fnos-nas-agent first-run setup code: 6f1c9a...
```

Rules:

- A caller whose socket address is loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) is
  already inside the appliance and does not need the code.
- Every other caller must send `code` together with `password`; a wrong or missing code
  is answered with `403` and the code is compared in constant time.
- The code file is deleted as soon as setup succeeds, and it is never generated again
  once a password exists.
- `GET /api/session` reports `setupCodeRequired` so a browser can show the field only
  when it is actually needed.

The mobile console asks for the code in the setup form and shows the hint that points at
the appliance log.

## 3. The execution policy is visible and enforced over HTTP

Every mutating HTTP path consults the same policy object that the tool registry uses:

| Route | `normal` | `read-only` | `halted` |
| --- | --- | --- | --- |
| `GET /api/health` | `executionMode: "normal"` | `executionMode: "read-only"` | `executionMode: "halted"` |
| `GET /api/tools` | `routineWriteExecutionEnabled: true` | `false` | `false` |
| `POST /api/tools/{id}/run` (read-only tool) | executed | executed | `503` |
| `POST /api/tools/{id}/run` (write tool) | executed | `403` | `503` |
| `POST /api/tools/{id}/run` (destructive tool) | `202` approval | `403` | `503` |
| `POST /api/files/operation` (write action) | executed | `403` | `503` |
| `POST /api/files/operation` (delete action) | `202` approval | `403` | `503` |
| `POST /api/files/operations/batch` (destructive entry) | `409` | `403` | `503` |

`GET /api/health` also reports `executionModeSource`, so an operator can tell whether the
mode comes from `<AGENT_DATA_DIR>/execution-mode.json`, from the `AGENT_EXECUTION_MODE`
environment variable, or from the default.

### The kill switch an operator can actually flip

The mode is not a compile-time constant. `GET /api/execution-mode` reports the current
mode and `POST /api/execution-mode` with `{"mode":"normal|read-only|halted"}` persists a
new one to `<AGENT_DATA_DIR>/execution-mode.json` (mode `0600`, written to a temporary
file and renamed into place).

- The endpoint requires a session and a same-origin request.
- It is deliberately **not** gated by the execution policy itself: an operator has to be
  able to lift the kill switch while the kill switch is engaged.
- An unknown mode is refused with `400` and never written.
- The mobile console exposes the same three modes in the service status card.
- The state file is also re-read every five seconds, so an out-of-band edit (for example
  over SSH on the appliance) takes effect without a restart.

## 4. Approvals are bound to the session that asked for them

A destructive action is never executed directly. The server answers with `202` and an
approval record, and the grant is stored with the session key of the requester:

- `GET /api/actions/pending` only lists the approvals of the calling session.
- `POST /api/actions/{id}/confirm` and `/deny` refuse a record that belongs to another
  session with `403` — the attempt does not consume the grant, so the rightful owner can
  still confirm it.
- The confirmation itself runs the tool with the server-held destructive capability, so
  the browser can never mint the confirmation itself.

## 5. Rate limits and startup robustness

- `POST /api/agent/message` accepts 20 requests per minute per session.
- `POST /api/tools/{id}/run` accepts 30 requests per minute per session.
- A failed audit write can no longer take the process down: the audit callback is
  wrapped, and the service registers `uncaughtException` and `unhandledRejection`
  handlers that log instead of exiting.
- A corrupt `skills.json` or `tasks.json` no longer prevents the service from starting
  (see Phase 129). `GET /api/health` reports `degraded: true` in that case, and
  `GET /api/diagnostics` lists the affected component under `degraded`.
- A model request that never returns is aborted after `AGENT_TASK_TIMEOUT_MS`
  (default 5 minutes, maximum 1 hour, `0` disables it) and the task is marked as timed
  out instead of blocking the queue.
- `server.closeAllConnections()` is used on shutdown, and the shutdown path is
  idempotent.

## 6. Reproducible line endings

`.gitattributes` pins `* text=auto eol=lf`. The release gates assert literal LF newlines
inside the Actions workflow, and a CRLF checkout made a local gate run disagree with the
runner. Binary assets (`.png`, `.jpg`, `.jpeg`, `.gif`, `.ico`, `.zip`, `.fpk`, `.woff2`)
are declared binary and are never normalized.

# Phase 146 — Tool call observability

## 1. The problem

The Agent can already say *what* it did, but only after the fact and only in a
shape that is useless for diagnosis:

* the **audit log** (`apps/fnos-nas-agent/app/audit-log.mjs`) records the HTTP
  request that *led to* a tool call — method, route, status code, and an
  allowlisted set of optional fields (`sessionId`, `toolId`, `target`, `risk`,
  `requestId`). It says nothing about the tool call itself: not how long it
  took, not how large the result was, not why it failed. A `500` on
  `POST /api/agent/message` cannot be told apart from a model timeout, a denied
  destructive action and a broken file path.
* the **task history** deliberately stores no inputs, prompts, results or raw
  exceptions, so it cannot be used as a diagnostic source either.
* the **console log** is free-form `console.error` output with no structure, no
  level and no field contract, so it cannot be filtered, counted or asserted
  on.

The result is that an operator who sees a failed task cannot answer the two
questions that matter: *which tool was slow*, and *which tool was refused*.

## 2. What this phase adds

Two new modules. Neither of them is wired into the request path by this phase —
see section 6 for the connection points the integration pass uses.

* `apps/fnos-nas-agent/app/tool-trace.mjs` — one trace record per tool
  invocation: identity, timing, outcome, result size and a fixed error
  classification. Held in a bounded in-memory ring buffer, optionally persisted
  as JSONL.
* `apps/fnos-nas-agent/app/structured-logger.mjs` — a one-line-per-event JSON
  logger with a level filter, a scalar-only field contract and an automatic
  filter for field names that look like secret carriers.

Both modules use only Node.js built-ins. No dependency was added.

## 3. The exported API

### 3.1 `createToolTracer`

```js
createToolTracer({ dataDir = "", maxEntries = 500, maxBytes = 1048576,
                   now = () => Date.now(), clock = () => new Date().toISOString(),
                   writeFile = null })
```

| Option | Meaning |
| --- | --- |
| `dataDir` | when it is a non-empty string, every trace entry is appended to `<dataDir>/tool-trace.jsonl`; when it is empty, the tracer is memory-only |
| `maxEntries` | the size of the in-memory ring buffer (1 … 100 000, default 500) |
| `maxBytes` | the size limit of the JSONL file before it is rotated (≥ 128) |
| `now` | the millisecond clock used for `durationMs` |
| `clock` | the ISO-8601 clock used for `startedAt` / `endedAt` |
| `writeFile` | an optional `(file, line) => Promise<void>` sink; when it is present, the tracer does not touch the file system itself (used by tests) |

The returned object is frozen and exposes:

| Member | Contract |
| --- | --- |
| `trace(context)` | returns an `async run(args, invokeFn)` wrapper. `context` accepts `toolId`, `risk`, `sessionId`, `taskId`, `requestId` |
| `list()` | a copy of the ring buffer, oldest first |
| `clear()` | empties the ring buffer; the JSONL file is not touched |
| `summary()` | `{ total, maxEntries, byTool, byOutcome, totalDurationMs }` — `byTool[toolId]` carries `count`, `totalDurationMs` and an `outcomes` map |
| `flush()` | resolves when the pending JSONL writes are on disk |
| `filePath()` | the JSONL path, or `""` when the tracer is memory-only |

`run(args, invokeFn)` awaits `invokeFn(args)`, returns its value unchanged and
**rethrows** its error unchanged — the wrapper is transparent for the caller. The
trace record is written in a `finally` block, so a failed call is recorded too.

### 3.2 The trace record

```js
{
  toolId, risk, sessionId, taskId, requestId,   // identity, already sanitized
  startedAt, endedAt, durationMs,                // timing
  outcome,                                        // "success" | "error" | "denied" | "timeout"
  resultBytes,                                    // size of the returned value
  errorClass,                                     // "" on success, otherwise a fixed class
  argsFingerprint,                                // sha256, first 16 hex characters
  argsBytes                                       // size of the serialized arguments
}
```

`outcome` and `errorClass` come from a fixed vocabulary
(`apps/fnos-nas-agent/app/tool-trace.mjs`, `classifyToolError`):

| `errorClass` | Trigger | `outcome` |
| --- | --- | --- |
| `validation-error` | status 400 / 422 | `error` |
| `policy-denied` | status 401 / 403, a missing capability, a read-only mode or a kill switch | `denied` |
| `not-found` | status 404, `ENOENT`, `ENOTFOUND` | `error` |
| `timeout` | `ETIMEDOUT`, `TimeoutError`, status 504 | `timeout` |
| `upstream-error` | status ≥ 500 | `error` |
| `cancelled` | `TASK_CANCELLED`, `ABORT_ERR`, `MODEL_REQUEST_ABORTED` | `error` |
| `unknown` | anything else | `error` |

### 3.3 `createStructuredLogger`

```js
createStructuredLogger({ stream = process.stdout, level = "info",
                         now = () => new Date().toISOString(), allowedFields = null })
```

`log(level, event, fields)` writes one JSON line:

```json
{"ts":"2026-10-22T00:00:00.000Z","level":"info","event":"tool.started","toolId":"files.list","durationMs":12}
```

The contract:

* **Levels.** `debug` < `info` < `warn` < `error`. A line below the configured
  level is dropped. An unknown level is normalized to `info`.
* **Field values.** Only `string`, `number`, `boolean` and `null` survive. An
  object or an array is dropped — a nested structure is the usual way a prompt
  or a payload sneaks into a log line.
* **Field names.** A name that mentions `key`, `token`, `secret`, `password`,
  `passwd`, `pwd`, `authorization`, `auth`, `cookie`, `credential`, `private`,
  `bearer`, `sessionid` or `apikey` is dropped *without looking at its value*.
* **Length.** A string longer than 256 characters is truncated to 256.
* **Envelope.** `ts`, `level` and `event` belong to the logger; a field can
  never overwrite them.
* **`allowedFields`.** When an array is given, only those field names are
  written.

`child({ event, ...context })` returns a logger that carries the context and
uses the given event name when no event is passed.

## 4. The red lines

These are the invariants the module exists to guarantee.

* **The arguments of a call are never stored.** Only `argsBytes` and
  `argsFingerprint` are recorded. The fingerprint is the first 16 hex
  characters of the SHA-256 of a canonical (key-sorted) serialization, so two
  identical calls produce the same value and the original arguments cannot be
  recovered from it.
* **The result of a call is never stored.** Only `resultBytes` is recorded.
* **A prompt, a task input, a credential or a file content never reaches a
  trace.** The same rule that Phase 20 established for the audit log and that
  the README states under *Safety boundaries* applies here.
* **An error message, a stack trace and an upstream body never reach a trace.**
  Only the fixed classification above is stored, so an endpoint, a token or a
  provider detail cannot leak through the diagnostic path.
* **A trace write never breaks the tool call.** The JSONL write is queued and
  its failure is reported on the console; the caller's result and error are
  unaffected.
* **The JSONL file is private.** The data directory is created with mode
  `0700`, the file with mode `0600`, and the file is rotated into a single
  generation (`tool-trace.jsonl.1`), exactly like `audit-log.mjs`.

## 5. What the tests cover

`tests/phase-146-tool-trace.test.mjs` holds 16 cases:

| Case | What it proves |
| --- | --- |
| a successful call | the identity, timing and result size are recorded, and neither the arguments nor the result appear in the entry |
| failures, denials and timeouts | the three error paths are classified, the error is rethrown, and no error message reaches the entry |
| duration and result size | `durationMs` and `resultBytes` match the measured values |
| the ring buffer | only the newest `maxEntries` entries survive, `clear()` empties it |
| the summary | the per-tool and per-outcome counters and the total duration |
| the JSONL file | one line per call, mode `0600`, no arguments on disk |
| the rotation | one rotated generation, both files below `maxBytes`, no second generation |
| the configuration | an invalid `maxEntries`, `maxBytes`, `now` or `writeFile` is refused |
| the error vocabulary | every class maps to the documented outcome |
| the structured logger | one JSON line per event, the field contract holds |
| the sensitive field names | a name that mentions a secret carrier is dropped and its value never appears |
| the scalar contract | an object and an array are dropped, a long string is truncated |
| the level filter | a line below the configured level is dropped |
| the child logger | the context and the event name are applied |
| the field allowlist | only the listed field names are written |
| the constructor | an unusable stream or clock is refused |

## 6. Wiring (for the integration pass)

This phase only creates the modules. The integration pass connects them to the
existing modules at these places:

1. **`apps/fnos-nas-agent/app/agent-core.mjs:125`** — the tool invocation loop
   (`const result = await tools.invoke(call.id, call.args);`). The tracer
   belongs here:

   ```js
   const run = tracer.trace({ toolId: call.id, risk: catalogue.get(call.id).risk, sessionId, taskId });
   const result = await run(call.args, args => tools.invoke(call.id, args));
   ```

   `catalogue` (`:100`) already holds the risk of every tool, and `sessionId`
   (`:140`) and `taskId` (`:156`) are already in scope. The wrapper returns and
   rethrows unchanged, so the loop needs no other change.

2. **`apps/fnos-nas-agent/app/server.mjs:486-496`** — the audit event of the
   request. The `finish` listener already resolves the session
   (`server.mjs:485`) and the route name (`server.mjs:482`). The tool context
   (`toolId`, `risk`, `target`, `requestId`) belongs here, so the audit trail
   and the trace agree on the identity of a call. The route names are already
   mapped at `server.mjs:460` (`agent.message`) and `server.mjs:472`
   (`tools.run`).

3. **`apps/fnos-nas-agent/app/audit-log.mjs:18`** — the existing optional
   field allowlist already contains `sessionId`, `toolId`, `target`, `risk` and
   `requestId`, with a 256-character bound (`audit-log.mjs:19`). **No new audit
   field is needed**: the integration pass only fills the fields that are
   already allowlisted.

4. **`apps/fnos-nas-agent/app/server.mjs`** — a `GET /api/agent/trace` route
   could expose `tracer.summary()` and `tracer.list()` to the authenticated
   console. The summary is metadata only: it contains counts and durations,
   never arguments or results.

5. **`apps/fnos-nas-agent/app/server.mjs`** — the startup path, where the
   structured logger replaces the ad-hoc `console.error` calls with
   `logger.error("tool.failed", { toolId, errorClass })`. The logger must never
   be handed a raw error object: the field contract drops it, because a
   non-scalar value is not written.

## 7. Known limitations

* The trace is in-memory and per process. A restart loses the ring buffer. The
  JSONL file survives a restart, but nothing reads it back yet.
* `summary()` walks the whole ring buffer on every call. With the default 500
  entries this is cheap, but a caller must not call it in a hot loop.
* The `risk` of a call is taken from the caller. The tracer does not verify it
  against the tool catalogue; a wrong value is stored as `unknown`.
* The fingerprint is a hash of the arguments. It is stable and irreversible in
  practice, but it is still a deterministic function of the arguments, so it
  must not be treated as a secret in itself — it is not published anywhere.
* The `writeFile` sink bypasses the mode and the rotation logic; it exists for
  tests, and a production caller should leave it unset.
* The POSIX mode bits are only enforced on a file system that supports them. On
  a Windows file system without a POSIX layer the file reads back as `0666`,
  which is a platform property and not a behaviour of this phase. The NAS
  runtime is Linux, so the `0600` contract holds there.

## 8. Compatibility

* No existing module was modified by this phase.
* No endpoint, no tool, no file format and no task record changed.
* The test suite is run with the Node.js 26 test runner:

  ```
  node --test tests/phase-146-tool-trace.test.mjs
  ```

* The repository documentation index (`docs/README.md`) has to list this
  document as a Phase 146 entry and its document count has to be raised by
  one; the release gate (`scripts/check-release-gates.mjs:409-413`) compares the
  index sentence with the real number of files in `docs/`.

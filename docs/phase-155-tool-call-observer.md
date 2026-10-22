# Phase 155 — Tool Call Observer

## 1. The problem

Phase 146 built the trace: `apps/fnos-nas-agent/app/tool-trace.mjs` can
record what a tool call was, how long it took and how it ended, without
keeping an argument, a result or a raw error.

The tracer was able to do that, but **nothing called it**. The built-in
catalogue (`apps/fnos-nas-agent/app/read-only-tools.mjs`), the agent plan
(`apps/fnos-nas-agent/app/agent-core.mjs`) and the external MCP tools all ran
without a trace entry. A trace file that only exists in a test is not
observability, it is decoration.

Three things were missing:

* a **single place** where a call is wrapped, so the built-in tools, the plan
  and the MCP tools cannot drift apart;
* a **terminal state** for every call, so a rejected call, an invalid argument
  list, a timeout and a thrown error all end up in a known shape instead of
  a missing record;
* a **safe** observation, so the new wiring cannot become a second place where
  a prompt, an argument value or a credential is stored.

## 2. What this phase adds

One new module, `apps/fnos-nas-agent/app/tool-call-observer.mjs`, with one
job: it wraps a tool call, watches how it ends and writes **exactly one
terminal record** per call.

The module is passive on purpose. It does not gate anything, it does not
change an error, it does not change a result and it does not change the order
of the calls around it. The wrapped function is called exactly once and the
caller still receives the same value and the same error.

### Change boundary

| File | Change |
| --- | --- |
| `apps/fnos-nas-agent/app/tool-call-observer.mjs` | new |
| `tests/phase-155-tool-call-observer.test.mjs` | new |
| `docs/phase-155-tool-call-observer.md` | new |

No existing file is modified by this phase. The wrapping of the three call
sites is done by the lead, because those files carry the routing, the policy
and the agent plan, and their behaviour must not change inside a phase that
only adds observability.

## 3. The exported API

```js
import {
  createToolCallObserver,
  classifyObserverError,
  OBSERVER_STATUSES,
  OBSERVER_ERROR_CODES
} from "./tool-call-observer.mjs";

const observer = createToolCallObserver({ trace, logger, clock, now, maxRecords });
```

### `createToolCallObserver({ trace, logger, clock, now, maxRecords })`

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `trace` | object or `null` | `null` | a Phase 146 tracer, or any object that accepts a record through `record()`, `push()`, `add()` or `append()` |
| `logger` | object or `null` | `null` | a Phase 146 structured logger, or any object with `log(level, event, fields)` |
| `clock` | function | `() => new Date().toISOString()` | returns the ISO timestamp of a moment |
| `now` | function or `null` | `null` | returns the epoch milliseconds of a moment; without it the milliseconds are read from `clock()` |
| `maxRecords` | number | `500` | how many records are kept in memory |

The observer returns a frozen object:

```js
observer.observe(context, fn);  // → the result of fn, or the error of fn
observer.listRecords(limit);    // → the records, oldest first
observer.clear();               // → removes every record from the memory
observer.summary();             // → { total, maxRecords, byStatus, bySource, byTool, totalDurationMs }
observer.count();               // → the number of records
observer.maxRecords;            // → the configured limit
```

### `observe(context, fn)`

```js
const result = await observer.observe(
  { toolId: "files.list", source: "builtin", risk: "read-only", sessionId, taskId, args },
  () => tools.invoke("files.list", args)
);
```

| Context field | Type | Meaning |
| --- | --- | --- |
| `toolId` | string | the identifier of the called tool |
| `source` | string or object | where the tool comes from: `builtin`, `skill`, `mcp` or the source object of the registry |
| `risk` | string | `read-only`, `write` or `destructive` |
| `sessionId` | string | the session the call belongs to |
| `taskId` | string | the task the call belongs to |
| `requestId` | string | the request the call belongs to |
| `args` | any | the arguments; they are reduced to a size and a fingerprint |
| `timeoutMs` | number | an optional deadline for the call |

The promise settles with the value of `fn`, and it rejects with the error of
`fn`. The observation never replaces either of them.

### `listRecords(limit)`

Returns a copy of the records, oldest first. `limit` takes the **most
recent** records and keeps them in chronological order: `listRecords(2)`
returns the last two calls. Without a limit every record is returned, a limit
of `0` returns an empty list.

## 4. Terminal states and error classification

Every observed call ends with exactly one record, and every record carries one
of the four terminal states:

```js
export const OBSERVER_STATUSES = Object.freeze(["ok", "error", "denied", "timeout"]);
```

| Situation | `status` | `errorCode` |
| --- | --- | --- |
| the call returned a value | `ok` | `""` |
| the call returned `{ ok: false, error: { code } }` | depends on the code | the mapped code |
| the arguments were refused (`400`, `422`) | `error` | `invalid_args` |
| the policy refused the call (`401`, `403`, `approval-required`, `missing-capability`, `read-only-mode`, `kill-switch`) | `denied` | `tool_denied` |
| the call ran into a deadline (`ETIMEDOUT`, `TimeoutError`, `504`, `timeoutMs` reached) | `timeout` | `timeout` |
| the tool was not found (`404`, `ENOENT`) | `error` | `not_found` |
| the model or the provider failed (`MODEL_FAILURE`, `MODEL_UNAVAILABLE`, …) | `error` | `model_failure` |
| the upstream service failed (any other `5xx`) | `error` | `upstream_error` |
| the call was cancelled (`TASK_CANCELLED`, `ABORT_ERR`) | `error` | `cancelled` |
| any other error | `error` | `tool_error` |
| an error that is not an object | `error` | `unknown` |

```js
export const OBSERVER_ERROR_CODES = Object.freeze([
  "invalid_args", "tool_denied", "timeout", "not_found",
  "model_failure", "upstream_error", "cancelled", "tool_error", "unknown"
]);
```

The base classification is the one of the trace module
(`classifyToolError` of `tool-trace.mjs`), so a record and a trace entry
never disagree about the same failure. The observer only adds the two codes
the trace does not know yet: `model_failure` and `tool_error`.

`classifyObserverError(error)` is exported as well, so a caller can classify
an error without observing a call.

## 5. The safety design

### No payload, ever

A record contains metadata only:

```js
{
  id, toolId, source, risk, sessionId, taskId, requestId,
  startedAt, endedAt, durationMs,
  status, errorCode,
  argsFingerprint, argsBytes
}
```

* the **arguments** are reduced to `argsBytes` and `argsFingerprint`, a
  `sha256` prefix of the canonical argument object. The arguments themselves
  are never stored;
* the **result** is not stored at all; only its size reaches the trace of
  Phase 146;
* the **error** is reduced to a code from the fixed vocabulary. The message,
  the stack and the upstream body stay where they are, because an upstream
  error can carry an endpoint or a token.

### Redaction

A value that looks like a credential is replaced with `[redacted]`, whether it
sits in a tool id, in a source or in any other field. The shapes that are
recognised are the common provider key prefixes (`sk-`, `ghp_`, `xox*`,
`AKIA`, `AIza`), a `Bearer` header, a long base64 blob, a bcrypt hash and an
`apiKey=…` / `token=…` style assignment.

The structured logger of Phase 146 keeps its own rule: a field **name** that
mentions a key, a token, a secret, a password, an authorization or a cookie is
dropped without looking at its value. Both rules together mean that neither
the name nor the value of a credential can reach a log line.

### Field whitelist

The observer logs one line per call, and that line carries six fields only:

```
toolId, source, risk, status, errorCode, durationMs
```

The session id and the task id stay in the record (a route needs them) and do
not go into the log line, because the logger treats a session id as a
credential carrier.

### Memory limit

At most `maxRecords` records are kept in memory (500 by default). The oldest
record is dropped when the limit is reached, so a long running server cannot
grow without bound. The persisted trace file is owned by the tracer of Phase
146 and is not touched by `clear()`.

## 6. The red lines that did not change

* **No prompt** reaches a record or a log line. The observer never sees a
  prompt; it only sees the arguments of one tool call, and those are
  fingerprinted, not stored.
* **No credential** reaches a record or a log line.
* **No argument value and no result value** reach a record.
* **No raw error message** reaches a record; the error is a code.
* **The observed call is not changed.** Same call, same arguments, same
  result, same error, same order.
* **Observation cannot break a call.** A tracer, a logger or a clock that
  fails is swallowed; the call still returns or throws what it always did.
* **A broken tool call cannot break the plan.** The error of the observed
  call is rethrown unchanged, so the caller still sees the original status
  code and the original message.

## 7. The tests

`node --test tests/phase-155-tool-call-observer.test.mjs` — 21 cases:

1. a successful call is recorded with the status `ok` and no error code;
2. a thrown error is recorded and rethrown to the caller;
3. an approval rejection is recorded as `denied`;
4. invalid arguments are recorded as `invalid_args`;
5. a timeout error is recorded with the status `timeout`;
6. a call that exceeds its deadline ends as a timeout;
7. a returned failure object is recorded as a terminal state;
8. a model failure and a cancellation keep their own error codes;
9. the duration is the time between the start and the end of the call;
10. only the most recent records are kept when the memory limit is reached;
11. no argument value and no credential ever reaches a record;
12. a value that looks like a credential is redacted;
13. `listRecords` returns the records in order and honours the limit;
14. `clear` removes every record from the memory;
15. every observed call ends with exactly one terminal record;
16. the observed function is called exactly once and keeps its result;
17. the trace of Phase 146 receives the call and the record;
18. the logger receives one line per call and no secret;
19. the summary counts the recorded calls;
20. the classifier maps the known error shapes onto the observer vocabulary;
21. an invalid observer configuration is refused.

## 8. Integration notes

The lead wraps the observer at the three call sites. The observer is
constructed once, next to the tracer of Phase 146, and injected into the three
places:

```js
// apps/fnos-nas-agent/app/server.mjs (or wherever the tracer is created)
const tracer = createToolTracer({ dataDir });
const observer = createToolCallObserver({ trace: tracer, logger });
```

### 1. The built-in catalogue

`apps/fnos-nas-agent/app/read-only-tools.mjs:178` — the `invoke(id, args,
options)` of `createReadOnlyToolRegistry`. The registry already receives an
`executionPolicy`; an `observer` is added next to it and the call is wrapped
around the existing body:

```js
async function invoke(id, args = {}, options = {}) {
  const tool = definitions.find(item => item.id === id);
  if (!tool) throw Object.assign(new Error("Unknown tool"), { statusCode: 404 });
  return observer.observe(
    { toolId: id, source: "builtin", risk: tool.risk, args },
    () => runTool(id, args, options)
  );
}
```

The wrapping keeps the two refusals above it (an unknown tool and an invalid
argument list) unwrapped, so a call that never reached the tool body is not
counted twice. The result and the error of the body are untouched.

### 2. The agent plan

`apps/fnos-nas-agent/app/agent-core.mjs:125` — the tool loop of
`executePlan`:

```js
const result = await tools.invoke(call.id, call.args);
```

The plan calls `tools.invoke`, so the call is already observed by the first
wrapping point. The plan only needs a second, coarser record when it wants to
see the plan itself: the observer of the plan reports the tool id and the
risk of the catalogue entry, not the arguments.

### 3. The external MCP tools

`apps/fnos-nas-agent/app/tool-registry.mjs:193` — the `run` of the registry:

```js
const run = () => source.invoke(tool.id, args, options);
```

The registry already accepts a `tracer` and uses it at
`tool-registry.mjs:194-197`. The observer is used in the same place, so a
foreign tool is observed exactly like a built-in one, with
`source: "mcp"` and the source id of the registry entry.

### 4. A route for the records

The records are the answer of a route such as `GET /api/agent/trace`:

```js
reply(res, 200, { records: observer.listRecords(limit), summary: observer.summary() });
```

The route is the only place where the records leave the process, so the
session scoping of the route is the session scoping of the trace.

## 9. Follow-up

* The observer keeps its records in memory only. A route that wants the
  history of a session should read the persisted trace file of Phase 146
  instead.
* The `source` of a record is a free text field today. It could be narrowed
  to `TOOL_SOURCE_KINDS` of the registry once every call site knows where its
  tools come from.
* The deadline of a call (`timeoutMs`) is optional. A global default for the
  MCP sources would remove the need to pass it at every call site.
* A per-tool latency histogram would answer "which tool is slow" without
  storing more than the current sum of the durations.

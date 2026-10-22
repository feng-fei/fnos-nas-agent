# Phase 146 — Task event stream

## 1. The problem

A task on the console is a black box. The client submits a task, polls
`GET /api/tasks/<id>` and redraws the whole card when the answer changes. Three
things follow from that design:

* **The conversation window cannot show progress as it happens.** The user
  learns that a plan of six tools ran only when the task is finished.
* **Every client polls.** The server answers a poll per client per interval,
  and each answer serializes the task again. A long plan produces a stream of
  nearly identical answers.
* **The intermediate state is invisible.** A tool that is slow, a destructive
  action that waits for a confirmation, a failure that is reported in the
  middle of a plan — none of it is observable while it happens. The task
  history only keeps the final state.

The server already has a place for a push channel: `server.mjs:1293-1328`
serves `GET /api/tasks/<id>/events` as a Server-Sent Events stream. The stream
was wired, but it had no data source: the task manager could not tell anybody
what happened inside a task.

## 2. What this phase adds

A single event source inside the task manager.

* `apps/fnos-nas-agent/app/task-manager.mjs` — the manager now publishes the
  life of a task to its subscribers: `progress`, `tool`, `approval`, `done` and
  `error`. A subscriber sees only the events of the task it subscribed to, and
  the stream ends with the task.
* `apps/fnos-nas-agent/app/task-manager.mjs` — `publicTask` became a module
  level export, so the HTTP layer and the event stream describe a task in
  exactly the same way. **Its fields did not change.**

No new dependency. No new endpoint. No change to the authentication, to the
task record or to the persisted history.

## 3. The exported API

### 3.1 `subscribe(taskId, listener)`

```js
const unsubscribe = taskManager.subscribe(taskId, listener);
```

`listener` receives one frozen event object. The shape is fixed:

```js
{ type: "progress" | "tool" | "approval" | "done" | "error",
  at: "2026-10-22T00:00:00.000Z",
  data: { ... } }
```

| `type` | `data` | When |
| --- | --- | --- |
| `progress` | `{ progress, stage }` | the executor called `reportProgress(value, stage)` |
| `tool` | `{ tool, result }` | a tool finished; `result` is the bounded result |
| `approval` | `{ task }` | the task waits for a destructive confirmation |
| `done` | `{ task }` | the task finished successfully or was cancelled |
| `error` | `{ message }` | the task failed |

A task ends with **exactly one** final event. A successful and a cancelled task
end with `done`, a failed task ends with `error`. The reason is the HTTP
layer: `server.mjs:1385-1389` closes the stream on the first final event it
sees (`done` or `error`), so a second final event would be written to a closed
stream. A client that needs the final record of a failed task reads it from
`GET /api/tasks/<id>`.

The return value is an `unsubscribe` function. Calling it stops the delivery;
calling it twice is harmless.

`subscribe` never throws. It returns `null` when the stream cannot be opened,
so the caller answers with a clean error instead of crashing:

| Situation | Result |
| --- | --- |
| `taskId` is not a non-empty string, or `listener` is not a function | `null` |
| the task already has 32 listeners | `null` |
| the process already has 1024 listeners | `null` |
| the task is already terminal | its final event is delivered **once**, and an empty `unsubscribe` is returned |
| the task already waits for a confirmation | one `approval` event is delivered, the listener stays subscribed |

### 3.2 `subscriberCount(taskId)`

The number of open listeners of one task. Used by the tests and by the
diagnostics endpoint.

### 3.3 `publicTask(task)`

```js
export function publicTask(task) { /* ... */ }
```

The public shape of a task. The fields are unchanged: `taskId`, `createdAt`,
`startedAt`, `completedAt`, `status`, `progress`, `stage`, `cancelRequested`,
`timeoutMs`, `timedOut`, `result`, `error`. The export exists so that the HTTP
layer and the event stream cannot drift apart.

### 3.4 The execution context gains `reportTool`

The executor may report a finished tool:

```js
context.reportTool("fnos.listDirectory", { entries: ["a", "b"] });
```

The tool name is cut to 80 characters. The result is bounded before it reaches
the stream, so a large tool output cannot flood a client. When the executor
does not report its tools, the finished result is used as a fallback source,
so the stream still shows which tools ran. A tool that was already reported is
not repeated.

## 4. The event order

For a normal, successful task:

```
progress → progress → tool → tool → done
```

For a task that asks for a confirmation first:

```
progress → approval → (the operator confirms) → tool → done
```

For a failed task:

```
progress → error
```

The last event of a stream is its single final event: `done` for a completed
or cancelled task, `error` for a failed one. A task that waits for a
confirmation is not terminal, so it does not emit a final event — the stream
stays open until the operator confirms or denies the action.

## 5. The red lines

* **The task input, the prompt and the credentials never reach the stream.**
  The task record keeps them (`task.input`), but `publicTask` does not expose
  `input`, and the event payload is built from `publicTask` only.
* **The tool arguments never reach the stream.** `reportTool(tool, result)`
  has no channel for the arguments at all: only the tool name and its result
  are published.
* **A tool result is bounded.** Every published result passes through
  `boundedTaskResult()`, and the results of one task share a single 16 KiB
  budget. A plan with many tools cannot push more than the cap through the
  stream.
* **A broken listener never breaks the task.** A listener that throws is
  caught, reported on the console and skipped. The other listeners still get
  the event, and the task keeps running.
* **A finished task never produces another event.** The listeners of a terminal
  task are removed with the task, so a late report cannot reach a client that
  already closed the stream.
* **A subscriber only sees its own task.** The listeners are stored per task
  id, and an event is only delivered to the listeners of that id.

## 6. What the tests cover

`tests/phase-146-task-events.test.mjs` holds 20 cases:

| Case | What it proves |
| --- | --- |
| the public task | `publicTask` keeps its field contract and is exported |
| a progress event | the reported value and stage arrive |
| the event shape | every event is exactly `{ type, at, data }` and uses a known type |
| a reported tool | the tool event carries the tool and its bounded result, and no arguments |
| the fallback source | the tools of the finished result are reported when the executor does not report them |
| no double report | a tool that was already reported is not reported twice |
| the result cap | a 200 KB tool result reaches the stream below 16 KiB and is marked as cut off |
| a finished task | the `done` event carries the public task |
| a failed task | the stream ends with a single `error` event that carries the reason |
| a reported failure | the failure reason of the executor reaches the `error` event |
| a pending confirmation | the `approval` event arrives and no `done` event is sent |
| the isolation | a subscriber only receives the events of its own task |
| unsubscribing | no event arrives after `unsubscribe`, and the listener is removed with the task |
| a late subscriber | a subscriber of a finished task is told once, immediately |
| the limit | the 33rd listener of a task is refused with `null` |
| an invalid subscription | a bad task id or a bad listener is refused with `null` |
| a broken listener | a listener that throws does not affect the task or the other listeners |
| the red lines | the prompt, the credential and the tool arguments are absent from the whole event stream |
| a resolved confirmation | the stream ends with a `done` event |
| a cancelled task | the stream ends with a `done` event |

## 7. Wiring (for the integration pass)

This phase only creates the event source. The server side of the contract is
already in place (the line numbers below are the ones of the current working
copy of `server.mjs`; the route is `GET /api/tasks/<id>/events`):

1. **`apps/fnos-nas-agent/app/server.mjs:1390`** —
   `unsubscribe = taskManager.subscribe(taskEventsMatch[1], send);`.
   The manager now answers this call. `send` (`server.mjs:1385-1389`) writes
   the event as `event: <type>` / `data: <json>`, and the event shape
   `{ type, at, data }` is exactly what the manager publishes.
2. **`apps/fnos-nas-agent/app/server.mjs:1388`** —
   `if (event.type === "done" || event.type === "error") close();`. The
   manager sends exactly one final event per task, so the stream is never
   written to after it was closed.
3. **`apps/fnos-nas-agent/app/server.mjs:1363`** — the route answers `501`
   when the manager has no `subscribe`. That check can stay; it now describes
   a real capability instead of a missing one.
4. **`apps/fnos-nas-agent/app/server.mjs:1364-1365`** — the task is looked
   up with the session of the request, so the stream inherits the session
   scoping of the task endpoint. The manager's `subscribe` is keyed by task id
   and is not session aware; the route keeps that check.
5. **`apps/fnos-nas-agent/app/agent-core.mjs:125`** — the tool invocation
   loop (`const result = await tools.invoke(call.id, call.args);`). The
   executor should report the finished tool through the context, so the stream
   shows the tool while the plan is still running:

   ```js
   const result = await tools.invoke(call.id, call.args);
   context.reportTool(call.id, result);
   ```

   The manager also reports the tools of the finished result as a fallback,
   so the stream is useful even before this call is added.
6. **`apps/fnos-nas-agent/app/server.mjs:1374-1384`** — the keep-alive timer
   and the `close` handler already release the subscription. The `close`
   handler calls the `unsubscribe` function that the manager returned, so a
   closed browser tab does not keep a listener alive.

## 8. Known limitations

* **The event source lives in one process.** A restart loses the subscribers
  and the running task, exactly like the task manager itself.
* **The stream is per task.** A client that wants the history of every task
  has to open one stream per task. The task list keeps using the polling
  endpoint.
* **A subscriber that is too slow blocks the emitting loop.** The events are
  delivered synchronously to the listener. A listener that blocks slows the
  task down; the HTTP layer writes to a socket and returns.
* **The 32 listeners per task are a limit, not a quota.** A listener that is
  never unsubscribed and whose task never finishes keeps its slot until the
  task ends. The global limit of 1024 listeners bounds the total.
* **A late subscriber of a finished task is told about the final state only.**
  The intermediate events are not replayed; the task history endpoint remains
  the way to look at the final record.
* **The POSIX mode bits are not touched by this phase.** The event stream
  writes nothing to the disk.

## 9. Compatibility

* `apps/fnos-nas-agent/app/task-manager.mjs` is the only source file that
  changed. The public task shape, the persisted history and the HTTP contract
  are unchanged.
* `publicTask` is now exported in addition to being used internally. The
  fields are the same.
* The execution context gains one member, `reportTool`. An executor that does
  not use it keeps working, and the manager falls back to the finished result.
* The test suite is run with the Node.js 26 test runner:

  ```
  node --test tests/phase-146-task-events.test.mjs
  ```

* The repository documentation index (`docs/README.md`) has to list this
  document as a Phase 146 entry and its document count has to be raised; the
  release gate (`scripts/check-release-gates.mjs:409-413`) compares the index
  sentence with the real number of files in `docs/`.

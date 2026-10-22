# Phase 137 — Task Queue and Approval Lifecycle

## Problem

The task queue and the destructive-action approval queue were two independent
lifecycles. A task that asked for a destructive confirmation had no way to
report that it was still waiting, an approval decision had no way to move the
originating task to its real end state, and neither side was bound to the
session that started the work.

The new lifecycle gives the queue an explicit `awaiting-approval` state, binds
every task to the session that submitted it, and links each pending approval to
the task that requested it.

## State machine

```
                 submit()
                    │
                    ▼
               ┌─────────┐   pump()    ┌─────────┐
               │ queued  │────────────►│ running │
               └─────────┘             └─────────┘
                    │                       │
        cancel()    │                       │  execute() → { status: "failed" }
                    ▼                       ▼
              ┌───────────┐            ┌─────────┐
              │ cancelled │            │ failed  │
              └───────────┘            └─────────┘
                    │                       │
                    │              execute() → { status: "awaiting-approval" }
                    │                       ▼
                    │               ┌──────────────────┐
                    │               │ awaiting-approval│  ← NOT a terminal state
                    │               └──────────────────┘
                    │                       │
                    │        resolveApproval(taskId, outcome)
                    │                       │
                    │      ┌────────────────┼────────────────┐
                    │      ▼                ▼                ▼
                    │  ┌─────────┐     ┌────────┐     ┌───────────┐
                    │  │completed│     │ failed │     │ cancelled │
                    │  └─────────┘     └────────┘     └───────────┘
                    │      ▲
                    │      │
                    └── cancel() ──► cancelled  (a waiting task can be cancelled)
```

Terminal states are `completed`, `failed` and `cancelled`. Only terminal tasks
are pruned from the bounded history and only terminal tasks are removed by
`clearTerminal()`.

### `awaiting-approval` is not terminal

When the executor returns `{ status: "awaiting-approval" }` the task stays in
that state:

- `completedAt` stays `null`.
- `progress` is capped at 99 so the UI never shows the task as finished.
- `stage` becomes `等待确认`.
- The task is not pruned from the history and not removed by `clearTerminal()`.
- The task can still be cancelled, which moves it to `cancelled` with the
  reason `任务已取消；待确认的操作已撤销。`.

An executor result of `{ status: "failed" }` marks the task `failed` (never
`completed`) and stores the reported message in `error`.

### `resolveApproval(taskId, outcome)`

`resolveApproval` is the only transition out of `awaiting-approval`:

| `outcome.status` | resulting task state | notes |
| --- | --- | --- |
| `completed` | `completed` | `progress` becomes 100, `completedAt` is stamped, `outcome.result` is stored |
| `failed` | `failed` | `outcome.error` (when present) is stored |
| `cancelled` | `cancelled` | `outcome.error` (when present) is stored |

Any other value is treated as `completed`. The call returns
`{ updated: true, task }` on a successful transition, `{ updated: false, task }`
when the task is not waiting for an approval (already `completed`, `failed` or
`cancelled`), and `null` for an unknown task id. It never throws.

Because the task already left `awaiting-approval`, a repeated call is a no-op:
`updated` is `false` and the original `completedAt` is preserved.

## Session binding

`submit(input, { sessionId })` stores the session on the task. The session is
part of the persisted snapshot, but never part of the public task payload.

Every read and every mutation is filtered by the session:

| Operation | Session rule |
| --- | --- |
| `get(taskId, sessionId)` | `null` when the task belongs to another session |
| `list({ sessionId })` | only the tasks of that session |
| `query({ sessionId })` | only the tasks of that session |
| `cancel(taskId, sessionId)` | `null` when the task belongs to another session |
| `clearTerminal(sessionId)` | removes only the terminal tasks of that session |

A task without a session (legacy history that predates the binding) stays
visible to every session. A caller without a session id sees everything, which
keeps the unauthenticated CLI and the internal callers working.

The HTTP layer passes the authenticated session key into every call:
`/api/tasks`, `/api/tasks/{id}`, `/api/tasks/{id}/cancel` and
`/api/tasks/clear-history`.

## Approval and task linkage

The agent core reuses the queue task id for the approval item. The queue hands
`context.taskId` to the executor, and the executor passes it to the approval
request, so one approval always points back to exactly one task.

```
task (awaiting-approval)  ──taskId──►  approval item (pending)
        ▲                                      │
        │  resolveApproval(taskId, outcome)     │ confirm() / deny()
        └──────────────────────────────────────┘
```

The server closes the loop:

- `POST /api/actions/{id}/confirm` → `actionApprovals.confirm(id, session)` →
  `taskManager.resolveApproval(taskId, { status: "completed", result })`.
- `POST /api/actions/{id}/deny` → `actionApprovals.revoke(id, session)` →
  `taskManager.resolveApproval(taskId, { status: "cancelled", error })`.
- `POST /api/tasks/{id}/cancel` → `taskManager.cancel(id, session)`; when the
  cancellation succeeded, `actionApprovals.revokeTask(id)` drops every pending
  approval of that task, so a cancelled task can never leave a confirmed
  destructive action behind.

## Timeout and cancellation semantics

- The queue owns an `AbortController` per task. On timeout the signal is
  aborted and the task becomes `failed` with `timedOut: true` and a timeout
  message.
- Cancelling a `running` task is cooperative: the current tool finishes, no
  follow-up tool step is started, and the task becomes `cancelled` when the
  executor reports `TASK_CANCELLED`.
- The agent core checks the cancellation signal before the model plan is
  generated and again before the plan is executed. A task that was cancelled or
  timed out while the model was thinking never reaches a tool: it raises
  `TASK_CANCELLED` and no tool call is made.
- A task that is waiting for an approval can be cancelled at any time. The
  cancellation is immediate, and the pending approval is revoked together with
  the task.

## Approval tokens are one-time

Every approval item carries a grant from the in-memory approval ledger. The
grant is bound to one task, one tool, one argument digest and one risk level.

- `confirm(id, sessionId)` first checks the ownership. A foreign session gets
  `403 The pending action belongs to another session`, and the grant is **not**
  consumed, so the owner can still confirm it.
- Only then the grant is consumed. The ledger accepts it exactly once; a
  second confirmation gets `404`.
- When the ledger refuses the grant (`approved: false`, for example an expired
  or tampered grant) the service answers `409 Confirmation is invalid or
  expired` and **keeps the pending item** in the queue, so a still valid action
  is never hidden by a failed attempt.
- Only after a successful consumption the destructive tool is invoked, with the
  `DELETE_CAPABILITY` capability.

## Revoke semantics

`revoke(id, sessionId)` returns the public pending item or `null`:

- An unknown or already handled id returns `null`.
- A foreign session gets `null` as well and cannot revoke another session's
  action.
- Revoking removes the queue entry **and** revokes every ledger grant of that
  task, so a sibling approval of the same task cannot survive.

`deny(id, sessionId)` is the boolean form of `revoke`: it returns `true` when
something was revoked and `false` for an unknown id. `revokeTask(taskId)` is the
task-scoped variant used by the cancellation path.

## Test coverage matrix

The regression suite lives in
`tests/phase-137-task-approval-lifecycle.test.mjs` and only uses the Node.js
standard library. It must pass on Windows and on Linux; no assertion depends on
POSIX permission bits or on directory descriptors.

| # | Case | Covered behaviour |
| --- | --- | --- |
| 1 | a task waiting for approval is not terminal and survives terminal history cleanup | `awaiting-approval` keeps `completedAt: null`, is not pruned, `clearTerminal()` removes nothing |
| 2 | resolveApproval completes a waiting task and stamps the completion time | `completed`, `progress: 100`, `completedAt` present, result stored |
| 3 | resolveApproval is idempotent once the task already reached a terminal state | second call reports `updated: false`, `completedAt` unchanged |
| 4 | resolveApproval ignores an unknown task identifier without throwing | no throw, nothing reported as updated |
| 5 | resolveApproval does not change a task that already reached completed or failed | `updated: false`, state and `completedAt` unchanged |
| 6 | an execute result of failed marks the task failed instead of completed | `failed`, not `completed`; error message stored |
| 7 | an execute result of awaiting-approval keeps the task waiting instead of completed | `awaiting-approval`, `completedAt: null` |
| 8 | a task submitted by one session stays invisible to another session | `get`/`list`/`query`/`cancel`/`clearTerminal` are session scoped |
| 9 | cancelling a task that waits for approval moves it to cancelled | `cancelled` plus a reason that contains `取消` |
| 10 | confirming an approval from another session is rejected and keeps the pending item | `403`, no tool call, grant not consumed |
| 11 | a rejected approval grant keeps the pending item in the queue | `409`, pending item still listed |
| 12 | deny reports a boolean result and returns false for an unknown identifier | boolean contract of `deny()` |
| 13 | revoke removes the pending item and returns null for an unknown identifier | `revoke()` contract |
| 14 | a confirmed approval advances the linked task from awaiting-approval to completed | approval and task are linked through the shared task id |
| 15 | the agent core reuses the queue task id for the approval item and invokes no tool | task id reuse, no tool before the confirmation |
| 16 | the agent core refuses to run a tool when the task was cancelled or timed out | `TASK_CANCELLED`, no tool executed |
| 17 | the server couples approval decisions and cancellations with the task lifecycle | the HTTP layer calls `resolveApproval` and `revokeTask` |

## Validation

Run the repository's supported Node.js 26.x test suite and release safety gate:

```sh
npm test
npm run check:release
```

The implementation is not considered fully validated until CI reports the result
of these checks.

# Phase 21: Task Persistence and Crash Recovery

## Behavior

- Store bounded task metadata in the private application data directory using an atomic temporary-file replacement.
- Restore recent terminal task history across service restarts.
- Mark persisted `queued` and `running` tasks as failed with a sanitized interruption message after restart.
- Never automatically replay interrupted work. Execution may not be idempotent, and the original input is deliberately not stored.
- Persist only task ID, timestamps, state, and sanitized error category/message. Never persist user prompts, task inputs, result payloads, credentials, or raw exception text.
- Keep task history bounded by `historyLimit`; queue admission remains governed by `queueLimit`.
- Write with owner-only file permissions and create the parent directory with owner-only permissions where supported.

## Failure policy

A missing state file means there is no prior history. Invalid JSON or an unsupported schema fails startup instead of silently deleting operational history. Persistence uses atomic rename to avoid partial snapshots. The manager exposes `ready` and `flush()`; the server waits for restoration before listening and flushes task state during graceful shutdown.

This is best-effort local state, not a distributed queue or a guarantee against storage-device failure or forced power loss.

## Acceptance

- Restart restores completed task metadata without restoring result data or input.
- Queued/running tasks become failed/interrupted and are not re-executed.
- Prompts, result values, and raw exception details are absent from persisted state.
- Corrupt state is surfaced instead of silently reset.
- Node.js 24 and 26 tests and Node.js 26 FPK build pass.

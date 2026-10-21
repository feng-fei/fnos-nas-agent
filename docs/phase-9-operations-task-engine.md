# Phase 9: Operations task engine

## What changes

- Adds an in-memory bounded task manager with queued/running/completed/failed states, timestamps, opaque task IDs, concurrency limits, bounded history, and sanitized errors.
- Agent message submission returns HTTP 202 and a task ID; clients poll task status instead of holding the request open during model calls.
- Authenticated task listing, detail, and queue-statistics endpoints support the mobile workbench.
- Adds a process-count-only diagnostic using Linux proc directory names. It does not read process command lines, environment variables, or process memory.
- Adds a direct intent for process count; all tools remain code-defined, read-only, and argument-free.

## API

- POST /api/agent/message: submits a task and returns 202 with a task summary.
- GET /api/tasks?limit=20: lists recent in-memory tasks.
- GET /api/tasks/:taskId: reads one task's status and result.
- GET /api/tasks/status: queue/running/retained counts.

All task endpoints require authentication. Submission is same-origin and JSON-only.

## Safety and operational limits

- Task history is in memory and cleared on service restart; prompts and results are not persisted to disk.
- At most two tasks execute concurrently by default, up to 20 waiting tasks are allowed, and up to 50 recent tasks are retained.
- No shell, subprocess, Docker socket, file mutation, service control, Skill execution, or arbitrary tool loading.
- Process diagnostics expose counts only, not process names, command lines, or environment variables.
- Task cancellation and durable history are deferred until their semantics can be tested safely.

## Validation

CI runs the full Node.js test suite on Node.js 24 and 26 and builds/inspects the FPK on Node.js 26.

# Phase 9: Operations task engine

## What changes

- Introduces an in-memory bounded task manager with queued/running/completed/failed states, timestamps, stable task IDs, concurrency limits, bounded history, and sanitized errors.
- The Agent message endpoint submits work and returns HTTP 202 with a task ID rather than holding the HTTP request open for a model call.
- Authenticated task listing and task detail endpoints support mobile polling and recent task history.
- Adds a process-count-only diagnostic. It counts numeric proc entries and never reads command lines, environment, or process memory.
- Adds a direct intent for process count; all tools remain code-defined, read-only, and argument-free.
- The UI polls task state and displays recent tasks.

## API

- POST /api/agent/message: submits a task; returns 202 { task }.
- GET /api/tasks?limit=20: latest in-memory task summaries.
- GET /api/tasks/:taskId: one task status and result.
- GET /api/tasks/status: queue/running/retained counts.

All routes require authentication. POST remains same-origin and JSON-only. Task IDs are opaque random identifiers; task endpoints reveal no tasks without a valid session.

## Safety and operational limits

- Task history is in memory and is cleared on service restart; it does not persist task prompts or results to disk.
- At most two tasks execute concurrently by default, at most 20 may wait in the queue, and at most 50 recent tasks are retained.
- No shell, subprocess, Docker socket, file mutation, service control, Skill execution, or arbitrary tool loading.
- Process diagnostics expose counts only, not process names, command lines, or environment variables.
- Task cancellation and durable history are deliberately deferred until their semantics can be tested safely.

## Validation

CI runs the complete Node.js test suite on Node.js 24 and 26 and builds/inspects the FPK on Node.js 26.

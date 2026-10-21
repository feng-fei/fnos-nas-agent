# Phase 106 — Honest API semantics for running-task cancellation

Aligns the task cancellation endpoint with the task manager's existing cooperative cancellation support.

- A queued task is removed immediately and returns HTTP 200 with `cancelled: true`.
- A running task sets `cancelRequested: true` and returns HTTP 202 Accepted. The current tool operation may finish; the Agent stops before starting follow-up tool calls.
- Repeated requests for a running task return 202 while cancellation remains requested.
- Terminal tasks that can no longer be cancelled return HTTP 409 with the current task record.
- The mobile client already treats all 2xx responses as accepted and displays the “current tool will finish; no follow-up tools” message.
- Authentication and same-origin POST requirements remain unchanged.

Validation includes the existing cooperative task-manager unit test plus an API contract test for the exact status/result semantics. Node.js 26 CI; no production NAS is used.

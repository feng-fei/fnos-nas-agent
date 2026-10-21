# Phase 58 — Filtered and paginated task history API

Adds server-side status filtering and offset pagination to the authenticated `GET /api/tasks` endpoint.

- Supported statuses: `queued`, `running`, `completed`, `failed`, and `cancelled`.
- Page size is clamped to 1–50 items.
- Offset is bounded to 0–10,000.
- Responses include the total matching count, effective limit/offset, active status filter, and the current page.
- Public task records remain sanitized; task inputs and raw exceptions are not exposed.

Node.js 26 tests cover filtering, pagination, and the task-history API contract.

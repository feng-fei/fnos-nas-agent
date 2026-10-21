# Phase 69 — Bounded retained task results

The task manager now projects completed results into a bounded, JSON-safe structure before retaining them in memory or returning them through task APIs.

- Maximum retained result size is approximately 16 KiB per task.
- Limits nested depth, object fields, array items, and string bytes.
- Prioritizes common summary fields such as message/status/tool results.
- Adds a `truncated` marker when content is clipped, and the mobile UI displays a notice.
- Existing task persistence still excludes result payloads and task inputs entirely.

This protects the in-memory task history and API responses from unusually large tool outputs. Tests cover oversized nested results while preserving the human-readable summary.

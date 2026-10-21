# Phase 61 — Mobile task history controls

- Filter task history by queued, running, completed, failed, or cancelled status.
- Paginate through the server-side task history using 10 items per page.
- Show the matched total and visible range.
- Keep the existing live refresh for active tasks and queued-task cancellation.
- Task inputs, prompts and raw exceptions remain absent from task history.

Automated coverage is a UI contract test; no real browser or fnOS NAS is used.

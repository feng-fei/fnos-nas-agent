# Phase 59 — Bulk Skill review transitions

Adds authenticated `POST /api/skills/transitions/batch` for reviewing a selected group of Skill records in one request.

- Accepts 1–20 unique Skill IDs per request.
- Applies the existing lifecycle transition rules one record at a time; invalid transitions do not silently bypass review.
- Returns per-item success/failure and aggregate counts so the mobile UI can retry failed items.
- Requires an authenticated session, same-origin request and JSON content type.
- Never extracts or executes Skill archive code; this endpoint changes metadata state only.

The API returns HTTP 200 when the batch is processed, even when individual records fail; callers must inspect each result. Invalid batch shape returns 400. This phase adds the API contract and test coverage; mobile bulk-selection controls are a follow-up UI task.

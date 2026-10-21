# Phase 51 — Authenticated Batch File Operations API

Adds `POST /api/files/operations/batch` on top of the existing bounded file-manager batch contract.

- Requires an active session, same-origin request, and JSON content type.
- Accepts the existing `{ "operations": [...] }` request shape; the manager enforces the 1–20 operation bound.
- Returns per-operation results, so a failed item does not hide later outcomes.
- Each operation continues to use the existing configured-root checks, no-overwrite rules, and explicit `confirm: true` requirement for deletion.
- The request body remains bounded by the server's existing JSON body limit.

This API adds no new permission bypass and does not execute arbitrary commands. It does not modify or access a live NAS during tests.

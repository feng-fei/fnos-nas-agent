# Phase 96 — Task history search

Adds keyword search to the existing authenticated task-history query and mobile UI.

- Searches task ID, status, stage, safe error summary, and timestamps only.
- Combines with the existing status filter and pagination.
- Bounds queries to 100 characters and rejects control characters at the HTTP boundary.
- Does not search or persist prompts, task inputs, credentials, or task result payloads.
- Search changes reset pagination so results do not begin on a stale page.

Validation: Node.js 26 unit, API-contract, and mobile UI regression tests. No real NAS is contacted.

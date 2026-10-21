# Phase 110 — Approval Queue Revocation Consistency

## Problem

The approval ledger revokes grants by task ID. The action approval service previously removed only one queue item when denying an approval or pruning an expired grant, while revoking every grant for that task in the ledger. Other queue entries for the same task could therefore remain visible even though confirmation could no longer succeed.

## Changes

- Centralize task-scoped revocation so the in-memory queue and approval ledger remain consistent.
- When any approval for a task is denied or expires, remove all queued approvals belonging to that task.
- Preserve queued approvals for unrelated tasks.
- Add regression coverage for task-scoped denial, expiration cleanup, independent tasks, one-time confirmation, and invalid requests.

## Validation

Run the repository's supported Node.js 26.x test suite and release safety gate:

```sh
npm test
npm run check:release
```

The implementation is not considered fully validated until CI reports the result of these checks.

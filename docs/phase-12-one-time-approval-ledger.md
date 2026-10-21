# Phase 12: One-time Approval Ledger

## Scope

- Issue opaque, high-entropy approval tokens for explicit write/destructive approval workflows.
- Store only token digests in memory.
- Bind each grant to one task ID, tool ID, risk tier, and canonical digest of JSON arguments.
- Enforce bounded lifetime (1–300 seconds), a hard pending-grant limit, expiry pruning, task cancellation/revocation, and single-use consumption.
- Fail closed for invalid risk tiers, invalid identifiers, malformed arguments, mismatched actions, expired grants, and replay.

## Safety boundary

This is a reusable ledger, not a UI or an execution endpoint. It does not authenticate callers, decide whether a human really approved, execute tools, or persist grants across process restarts. A future API must derive the task/action/risk on the server, require an authenticated same-origin explicit confirmation, and never accept model-supplied approval flags. No write/destructive tools are enabled by this phase.

## Validation

Tests cover one-time use, action binding, stable argument hashing, expiry, revocation, capacity, and fail-closed risk handling. Require Node.js 24/26 tests and Node.js 26 FPK packaging before merge.

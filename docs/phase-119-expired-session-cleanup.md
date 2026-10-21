# Phase 119 — Expired Session Cleanup Error Handling

## Problem

When a request arrived with an expired session, the request path removed that session and triggered a persistence snapshot without awaiting or attaching a rejection handler. If the filesystem was temporarily unavailable, the rejected promise could become an unhandled rejection in Node.js and may terminate the process depending on runtime policy.

## Changes

- Keep the cleanup asynchronous so routine requests do not wait on a disk write.
- Attach an explicit rejection handler and emit only a fixed, sanitized diagnostic message. File paths, raw errors, session IDs and credentials are not logged.
- Preserve the persistence queue's recovery behavior from Phase 115; a failed cleanup write does not poison later session writes.
- Add a regression test that enforces the handled background-promise contract and rejects the old fire-and-forget pattern.

## Validation

Run `npm test` and `npm run check:release` on Node.js 26.x. This protects process stability and prevents sensitive filesystem error details from entering logs; it does not replace real fnOS log/permission testing.
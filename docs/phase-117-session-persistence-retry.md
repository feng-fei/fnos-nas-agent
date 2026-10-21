# Phase 117 — Recoverable Session Persistence

## Problem

Session snapshots were serialized by chaining each write from the previous promise. A single filesystem failure left that promise rejected, so subsequent login/logout/expiry writes never ran until the service restarted. Login would fail closed when its own write failed, but a later healthy write could not recover the queue in-process.

## Changes

- Introduce a small reusable serial write queue that preserves operation ordering, returns each operation's own result/error, and recovers the internal queue after a rejected write.
- Use the queue for session snapshots so a transient filesystem error does not disable all later session persistence.
- Write snapshots through a unique, exclusive temporary file, apply private permissions, atomically rename into place, and clean up temporary files after failure.
- Add regression coverage for queue recovery, ordering, individual result propagation, and invalid work callbacks.

## Validation

Run the Node.js 26.x test suite and release safety checks:

```sh
npm test
npm run check:release
```

The regression tests cover queue semantics and do not replace authentication testing or a real fnOS lifecycle test. Session persistence failures continue to fail the affected request rather than reporting a successful login without durable session state.

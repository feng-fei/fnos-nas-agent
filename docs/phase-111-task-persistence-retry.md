# Phase 111 — Task Snapshot Persistence Retry

## Problem

The task manager serialized snapshot writes through a promise chain. If a filesystem error rejected one write, later writes chained directly from that rejected promise and never invoked the snapshot writer again. A transient storage failure could therefore disable task-history persistence until the process restarted.

## Changes

- Recover the serialization chain from a prior rejected write before scheduling the next snapshot.
- Preserve the original failure for callers awaiting that particular write; a later flush explicitly retries persistence.
- Add a regression test that forces a deterministic filesystem failure, restores the storage directory, and verifies that a later flush writes the task snapshot.

## Validation

Run the supported Node.js 26.x test suite and release-safety checks:

```sh
npm test
npm run check:release
```

This phase verifies recoverable task-history writes. It does not change the safety policy: queued or running tasks restored after a process restart are still marked interrupted and are never automatically replayed.

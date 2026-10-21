# Phase 123 — Recoverable Skill Inventory Persistence

## Problem

The Skill inventory chained writes using the previous write promise. After one filesystem failure, the queue stayed rejected and later registrations, state transitions, and removals could not persist during the same process lifetime. Writes also reused a fixed temporary pathname and did not guarantee cleanup of partial temporary files.

## Changes

- Reuse the shared serial write queue, which preserves ordering and propagates each operation's own error without poisoning subsequent writes.
- Use a random per-write temporary name opened exclusively with `flag: "wx"`, private permissions, atomic rename, and explicit cleanup after errors.
- Reapply restrictive permissions to the atomically published inventory file.
- Allow the storage filesystem methods to be injected into the store, so tests can deterministically simulate a disk error after a temporary file has been created.
- Add regression coverage proving that a failed register is rolled back, its temporary file is removed, the next registration persists successfully, and a fresh store can load the recovered inventory. Also cover simultaneous registrations.

## Validation

Run:

```sh
npm test
npm run check:release
```

The injected filesystem test exercises persistence recovery deterministically; it does not replace storage-device or real fnOS lifecycle validation.

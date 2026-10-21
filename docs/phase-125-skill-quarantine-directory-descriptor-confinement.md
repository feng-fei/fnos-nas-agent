# Phase 125 — Skill Quarantine Directory Descriptor Confinement

## Problem

The ZIP quarantine writer checked the quarantine directory with lstat, then used mutable pathnames for the temporary archive, final archive, chmod, and read-back verification. A directory replacement between check and use could redirect a write or checksum verification to a different filesystem location. Renaming a same-digest archive also allowed an existing destination to be replaced rather than verified as immutable content.

## Changes

- Open the configured data directory and quarantine directory with Linux directory/no-follow flags and verify device/inode identities.
- Perform temporary-file creation, file syncing, hard-link publication, and verification through the already-open quarantine directory descriptor using /proc/self/fd.
- Use exclusive random temporary files with mode 0600 and verify the destination through an opened no-follow file handle.
- Treat an existing same-digest destination as immutable: it must pass its own hash check and is never overwritten.
- Revalidate the original data/quarantine directory paths after publication; if either path changes, return a retryable conflict and clean up a destination created by this invocation only when its identity is confirmed.
- Add regression tests for symlink substitution before the quarantine directory is opened and path replacement after its descriptor is open.

## Platform and validation

The hardened quarantine writer requires Linux /proc/self/fd, available in the target Linux-based fnOS runtime. Non-Linux systems fail closed instead of reverting to pathname-only writes.

Run:

```sh
npm test
npm run check:release
```

These tests exercise descriptor-relative storage and path-swap races on the Linux CI filesystem. Real fnOS filesystem and device acceptance remains a separate staging gate.

# Phase 113 — FPK Lifecycle Process Identity

## Problem

The native FPK launcher previously trusted only the PID stored in `TRIM_PKGVAR/agent.pid` and whether `kill -0` succeeded. If the service exited and the OS later reused that PID, `status` could report a false positive and `stop` could signal an unrelated process. If `TRIM_PKGVAR` was missing, concatenation produced the unsafe path `/agent.pid`.

## Changes

- Leave `PID_FILE` empty if `TRIM_PKGVAR` is not configured.
- Make `stop` a no-op when the package data path is unavailable; `status` continues to fail closed.
- Before reporting a process as running or signaling it, verify that its Linux `/proc/<pid>/cmdline` contains the exact configured bundled Node.js path and the app entry path.
- Add regression tests for an unrelated live PID and for a missing `TRIM_PKGVAR`.

## Validation

Run `npm test` and `npm run check:release`, plus the workflow's `bash -n` validation. The regression test uses the test runner's own PID in a temporary PID file and proves the stop command leaves the process alive.

This is a Linux fnOS lifecycle-script hardening change. It does not claim real-device certification; stop/status behavior must still be confirmed on a disposable test NAS after installing the CI FPK.

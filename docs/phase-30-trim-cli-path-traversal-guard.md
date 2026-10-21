# Phase 30 — fnOS CLI Path Traversal Guard

## Delivered

- Reject `.` and `..` path segments before passing storage paths to the official CLI.
- Reject backslashes and ASCII control characters in storage paths.
- Preserve the existing `/volN` root restriction, maximum path length, fixed argv invocation, and read-only command allowlist.
- Add regression tests for parent traversal, dot segments, and backslash-separated paths.

## Safety boundary

This hardening narrows accepted input only. It adds no commands, permissions, or filesystem operations and does not replace verification against the official CLI on a test fnOS device.

## Acceptance

Node.js 24/26 tests, release gates, syntax checks, and FPK packaging must pass.

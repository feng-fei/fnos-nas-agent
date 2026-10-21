# Phase 42 — CLI connection health and guided verification

## What changed

- The authenticated agent status API now distinguishes CLI installation/executable availability from connection verification.
- Merely finding an executable no longer causes the UI to claim the CLI is connected or OAuth is authenticated.
- Added an authenticated, same-origin `POST /api/agent/trim-cli/test` endpoint. It runs only the fixed allowlisted read-only `system.info` operation through the CLI adapter.
- The endpoint returns success only when the CLI completes the read-only probe. Failure responses suppress raw CLI stderr and distinguish missing/unavailable CLI, timeout, and general connection failure.
- Added a mobile-friendly “检测官方 CLI 连接” button and explicit not-yet-verified status messaging.
- Added HTTP contract tests for unauthenticated/unavailable status, same-origin enforcement, and missing-binary behavior. The new audit route is allowlisted and covered by release gates.

## OAuth boundary

This phase does not implement browser OAuth, collect authorization codes, request passwords from the CLI, or persist tokens. The user must configure the official CLI profile through its supported interactive flow, with profile files kept under the Agent's private data directory. The connection test only verifies whether the existing profile can complete a read-only API request.

## Validation and limits

Node.js 26 remains the only development CI runtime. FPK build, checksum and provenance jobs remain paused. CI is not a substitute for testing on a real fnOS NAS; this phase does not access or modify a NAS.

# Phase 22: Release Candidate Acceptance

## Goal

Make a release candidate reviewable as a single acceptance package after Phases 19–21. CI success proves repeatable software checks; it does not certify an installation on every fnOS version or NAS hardware.

## Automated release gates

- Node.js 26 runs the complete built-in test suite and release safety gate.
- The same workflow builds an x86 test FPK, checks package structure, generates a SHA-256 sidecar and unsigned release manifest, and verifies that all fields agree.
- Release gate script verifies runtime dependency policy, FPK workflow and package inspection, and the no-arbitrary-execution boundary.
- Release gate script also checks that task persistence is wired into server startup/shutdown, inputs/results/raw errors are excluded from durable task state, interruption recovery never auto-replays work, and audit storage remains bounded.
- Node.js 26 builds the FPK, verifies archive structure, and publishes the package with a checksum.
- The exact latest commit must have successful PR checks; a successful earlier commit is not sufficient.

## Required staging checklist

Before declaring a production-ready release, an operator must validate on a disposable fnOS test NAS:

1. Install and first-run initialization using the actual FPK.
2. Start, stop, restart, upgrade, and uninstall lifecycle scripts.
3. Login/session behavior and mobile browser use over the intended trusted network.
4. Read-only diagnostics and allowlisted tool flows.
5. Task completion, graceful restart, interrupted-task recovery, and bounded history.
6. Audit log permissions, rotation, and absence of credentials/prompts.
7. App data survives upgrade where intended; uninstall does not delete unrelated user data.
8. Backup and rollback procedure; checksum matches the exact FPK tested.
9. Confirm HTTP is not exposed to untrusted networks unless TLS/reverse-proxy protections are configured.

## Release decision

A test artifact is **CI-verified** only when the exact latest PR commit passes Node.js 26 tests, release gates, FPK build, package inspection, checksum generation, and manifest verification.

A release is **fnOS-staging-verified** only after the above checklist is completed on a disposable test NAS and the tested artifact checksum is recorded.

Do not label a build production-ready based on CI alone. CI must never install, restart, or modify a production NAS.

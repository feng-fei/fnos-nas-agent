# Phase 24: Release Hygiene and Smoke Checks

## Purpose

Keep release instructions, branch triggers, and automated safety gates aligned so a completed phase cannot silently disappear from the mainline or become hard to validate.

## Automated acceptance

- README links to the Phase 21 persistence and Phase 22 acceptance documents resolve to tracked files.
- README phase index has no accidentally escaped newline before a Markdown list item.
- FPK CI runs for Phase 23 and Phase 24 branches as well as the mainline pull request.
- Node.js 24 and 26 run the full test suite and release gates; Node.js 26 packages and inspects the FPK and emits a SHA-256 checksum.

## Manual fnOS smoke checklist

Run only on a disposable test NAS, never as part of CI:

1. Verify the downloaded FPK checksum before installation.
2. Install and complete first-run setup.
3. Confirm login, logout, session expiry, and mobile browser layout.
4. Confirm unauthenticated requests cannot access protected endpoints.
5. Confirm read-only diagnostics and tools work without enabling arbitrary execution.
6. Restart the service and verify terminal task history returns while interrupted tasks are not replayed.
7. Verify audit/task files are private and contain no passwords, session cookies, prompts, task results, or raw exception text.
8. Upgrade and uninstall; confirm intended application data handling and no unrelated user-data deletion.
9. Record fnOS version, package SHA-256, test date, and pass/fail for every item.
10. Test backup restoration and rollback before production rollout.

## Release decision

Passing CI means **CI-verified** only. Use **fnOS-staging-verified** only after a human completes and records the checklist against the exact FPK checksum. Do not install, restart, or modify a production NAS as part of automated release checks.

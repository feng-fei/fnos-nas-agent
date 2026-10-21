# Phase 123 — Bundled Runtime FPK Lifecycle Smoke

## Goal

Run the packaged Node.js runtime and actual application entry from the same temporary staging tree that fnpack will package. Static syntax checks and copying a runtime binary are not enough to prove that the executable can start this application's dependency-free module graph.

## CI behavior

- After `Stage native FPK` copies Node.js 26.x to `app/bin/node` and prepares the package tree, run `cmd/main` with `TRIM_APPDEST` pointing to the staged `app/` directory and `TRIM_PKGVAR` pointing to fresh temporary storage.
- Set the service port to `0` so Node binds an ephemeral port on the isolated GitHub-hosted runner rather than colliding with another service.
- Start the actual `app/server.mjs`, confirm the PID file and process identity, check status, issue a second start and require the same PID, stop the process, require PID cleanup, and verify status returns 3 (stopped).
- Always run the lifecycle stop command in a shell trap so a failed assertion does not intentionally leave the child service running on the CI runner.
- Perform this smoke test before invoking fnpack, so an unusable bundled runtime fails the package job early.

## Boundaries

This runs the staged source tree with the exact Node binary intended for the FPK, not a package installed onto fnOS hardware. The outer FPK archive is separately checked, and the successful workflow still emits checksum/manifest and provenance attestation. Real install, app-center lifecycle, authentication/session expiry, upgrade/rollback, and uninstall acceptance require a disposable test NAS and a recorded artifact checksum.

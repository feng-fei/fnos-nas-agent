# Phase 117 — FPK Lifecycle Smoke Verification

## Goal

Validate the native lifecycle script contract on a Linux CI runner using an isolated fake app install directory and a temporary data directory. These tests catch regressions in the start, status, and stop commands without claiming real fnOS installation acceptance.

## Automated coverage

- Use the current Node runtime through a temporary symlink at the package's expected bin/node path and a minimal long-running HTTP server fixture.
- Include spaces in app and data paths to check shell quoting.
- Verify start creates a PID file, and that PID identity matches both the expected runtime path and app entry.
- Verify status reports a running service, repeated start reuses the same PID, and stop terminates the process and removes the PID file.
- Verify status reports stopped after shutdown and start fails closed when the bundled runtime is missing.

## Network and first-run setup

The native launcher explicitly sets HOST=0.0.0.0, so the first-run setup UI is reachable from the LAN before the management password is configured. Install and perform first-run setup only on a trusted private network, configure the password immediately, and do not port-forward the HTTP service to the public internet. Treat the initial setup state as first-come-first-served until this behavior has been verified on the intended fnOS release.

## What CI does not validate

The smoke test uses Linux /proc, a local Node runtime, and a temporary folder; it does not call fnOS application-center APIs or install an FPK on a NAS. A disposable test NAS must still validate first installation, service startup, stop/restart, app-center status, authentication/session expiry, upgrade/rollback/uninstall and data retention, recording the exact FPK SHA-256 and fnOS version.

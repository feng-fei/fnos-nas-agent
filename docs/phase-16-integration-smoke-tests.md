# Phase 16: FPK Integration Smoke Tests

## Scope

- Verify the complete fnOS lifecycle command set exists and parses as Bash.
- Check that the FPK manifest, launcher environment, bundled Node.js location and service port stay consistent.
- Guard against accidental destructive cleanup in upgrade/uninstall hooks.
- Verify install initialization fails closed when fnOS does not provide the app-data path.
- Keep all tests offline and non-mutating: CI never starts the NAS service, installs an FPK, or modifies a real NAS.

## Acceptance

- Node.js 24 and 26 unit tests pass.
- Release readiness checks pass.
- The Node.js 26 job builds and inspects an FPK artifact and publishes its checksum.
- A separate disposable fnOS test instance is still required for real install/start/stop/upgrade/uninstall validation.

## Out of scope

This phase does not deploy to a NAS, execute imported Skills, or enable arbitrary commands.

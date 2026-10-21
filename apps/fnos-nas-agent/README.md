# Native FPK package

GitHub Actions builds an **unsigned x86 CI test FPK** from this template. The artifact build, archive inspection, checksum and manifest checks run in an isolated CI staging directory. This is a CI-verified package only; it has not been certified by installing it on real fnOS hardware.

## Package behavior and staging

- Intended for x86_64 fnOS devices.
- The pipeline copies the Node.js 26.x executable selected by `actions/setup-node` to `app/bin/node` in a temporary package copy. The runtime binary is not committed and is not downloaded when the app is installed.
- Desktop PNG icons are generated into the same temporary package copy before fnpack runs.
- The main lifecycle script uses the bundled `app/bin/node` and starts `server.mjs` with `AGENT_DATA_DIR` pointing to the package's private data directory.
- Imported Skill code and arbitrary shell execution remain disabled; this FPK still requires real-device security and lifecycle validation before any non-test use.

## Manual acceptance still required

Verify the artifact's SHA-256 against the sidecar and release manifest, then use only a disposable test fnOS NAS. Check install and first-run password setup, login/session expiry, app-center start/stop/restart, read-only tool and file workflows, task recovery after restart, audit/task directory permissions, upgrade/rollback, uninstall and data retention. Record the exact checksum and fnOS version. CI does not run these operations and must never modify a production NAS.

See [the CI build description](../../docs/fpk-ci-build.md) and [the staging test plan](../../docs/fpk-test-plan.md).

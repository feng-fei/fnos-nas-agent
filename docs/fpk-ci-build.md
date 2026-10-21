# FPK CI build

The repository builds the native x86 FPK on GitHub Actions; no build tools are installed on the NAS.

## Trigger

- Push changes affecting the app or build script to `phase-2/fpk-packaging`.
- Or use **Actions → Build fnOS FPK → Run workflow**.

## What the workflow does

1. Prepares Node.js 22.17.0 on the GitHub-hosted Ubuntu x86_64 runner and bundles its executable in the app payload.
2. Generates valid PNG icons with a Python standard-library script and validates the required `config/privilege` and `config/resource` JSON plus `wizard/` directory.
3. Checks shell syntax and the Node.js entry point.
4. Downloads official `fnpack 1.2.3` and verifies its SHA-256 before executing it.
5. Builds the FPK and uploads the package plus a SHA-256 checksum as a 14-day Actions artifact.

The artifact is a **test build**, not a production release. The package uses `run-as: package` with no additional groups or shared resources. A successful CI build proves packaging and static checks only; it does not prove installation or lifecycle behavior on a real fnOS device.

## Download the artifact

Open the workflow run in the repository's **Actions** tab, open the successful run, and download `fnos-nas-agent-test-fpk`.

## Safety boundary

The current app is status-page-only. Its lifecycle script binds the HTTP server to loopback. This build does not enable LAN access, shell execution, Skills, model calls, or NAS administration. Do not expose it to a network until authentication and authorization are implemented and tested.

## Follow-up real-device validation

On a test fnOS device, install the downloaded FPK through the app center and validate install, start, status, stop, restart, and uninstall. Do not treat a green CI build as a substitute for this step.

# FPK CI build

The repository builds the native x86 FPK on GitHub Actions; no build tools are installed on the NAS.

## Runtime policy

- **Node.js 26.x is the default packaged runtime** because the user has confirmed it runs normally on the target fnOS NAS.
- The workflow follows the latest patch release within the Node.js 26.x line automatically.
- Node.js 24.x remains a test-only regression line for core tests and source/shell syntax checks. It does not produce an FPK artifact.
- When a newer Node.js major becomes the preferred runtime, update the CI matrix and packaging condition in a reviewed PR, run all checks, then test the generated FPK on fnOS before switching the default.

This policy means "use the latest Node.js" within a tested release line, not silently package an untested major version. CI does not prove that Node 26 is faster or uses less memory than Node 24.

## Trigger

- Push changes affecting the app or build script to the FPK packaging, `phase-2/**`, `fix/**`, or `test/**` branches.
- Or use **Actions → Build fnOS FPK → Run workflow**.

## What the workflow does

Both Node.js lines run the core test suite and validate the application entry point and lifecycle shell scripts. Only Node.js 26.x performs the full FPK pipeline:

1. Bundle the resolved Node.js executable into the app payload.
2. Generate PNG icons and validate the required package metadata and wizard directory.
3. Download official `fnpack 1.2.3` and verify its SHA-256 before executing it.
4. Build the x86 FPK, inspect its contents, generate a SHA-256 checksum, and upload the test artifact for 14 days.

The artifact is named `fnos-nas-agent-test-fpk-node-26.x`. Open the successful workflow run in the repository's **Actions** tab to download it.

## Network and safety boundary

The current test app is status-page-only and binds to `0.0.0.0` so computers and phones on the LAN can reach it. The only HTTP routes are the status page and `GET /api/health`; NAS command execution, Skill execution, and model calls remain disabled.

**Security note:** this status-only build has no client authentication. Binding to `0.0.0.0` listens on all network interfaces; it does not itself restrict access to the LAN. Use only on a trusted private LAN, do not configure router port forwarding, and do not expose port 18787 to the public internet. Before adding any NAS management or execution features, implement and test authentication, authorization, CSRF protections where applicable, and explicit confirmation for risky actions.

## Follow-up real-device validation

The next fnOS test remains a manual, user-controlled step. Validate install, start, status, stop, restart, and uninstall through the app center, and confirm that `/api/health` returns HTTP 200 from a LAN client. CI does not install or change anything on the NAS and does not replace lifecycle testing on the target fnOS version.

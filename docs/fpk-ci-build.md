# FPK CI build

The repository builds the native x86 FPK on GitHub Actions; no build tools are installed on the NAS.

## Trigger

- Push changes affecting the app or build script to the FPK packaging branch.
- Or use **Actions → Build fnOS FPK → Run workflow**.

## What the workflow does

1. Uses the latest patched Node.js 24.x LTS release on the GitHub-hosted Ubuntu x86_64 runner and bundles that executable in the app payload. The workflow prints the resolved Node.js version so each build is traceable.
2. Generates valid PNG icons with a Python standard-library script and validates the required `config/privilege` and `config/resource` JSON plus `wizard/` directory.
3. Checks shell syntax and the Node.js entry point.
4. Downloads official `fnpack 1.2.3` and verifies its SHA-256 before executing it.
5. Builds the FPK and uploads the package plus a SHA-256 checksum as a 14-day Actions artifact.

Node.js is pinned to the maintained 24.x LTS major line rather than an old fixed patch version, so GitHub Actions resolves the latest available security-patched 24.x release when the workflow runs. The exact resolved version is printed in the build log.

The artifact is a **test build**, not a production release. The package uses `run-as: package` with no additional groups or shared resources. A successful CI build proves packaging and static checks only; it does not prove installation or lifecycle behavior on a real fnOS device.

## Download the artifact

Open the workflow run in the repository's **Actions** tab, open the successful run, and download `fnos-nas-agent-test-fpk`.

## Network and safety boundary

The current test app is status-page-only and binds to `0.0.0.0` so computers and phones on the LAN can reach it. The only HTTP routes are the status page and `GET /api/health`; NAS command execution, Skill execution, and model calls remain disabled.

**Security note:** this status-only build has no client authentication. Binding to `0.0.0.0` listens on all network interfaces; it does not itself restrict access to the LAN. Use only on a trusted private LAN, do not configure router port forwarding, and do not expose port 18787 to the public internet. Before adding any NAS management or execution features, implement and test authentication, authorization, CSRF protections where applicable, and explicit confirmation for risky actions. A LAN-accessible status page is not a security boundary by itself.

## Follow-up real-device validation

On a test fnOS device, validate install, start, status, stop, restart, and uninstall through the app center. Also confirm that the service listens on the intended interfaces and that `/api/health` returns HTTP 200 from a LAN client. Do not treat a green CI build as a substitute for lifecycle testing on the target fnOS version.

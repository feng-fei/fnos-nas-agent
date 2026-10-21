# FPK CI build

The repository builds the native x86 FPK on GitHub Actions; no build tools are installed on the NAS.

## Trigger

- Push changes affecting the app or build script to the FPK packaging, `fix/**`, or `test/**` branches.
- Or use **Actions → Build fnOS FPK → Run workflow**.

## Node.js compatibility matrix

The workflow tests two runtime lines in separate jobs:

- **Node.js 24.x LTS** — supported compatibility baseline.
- **Node.js 26.x** — preferred runtime candidate after the user confirmed that a Node.js 26 build runs normally on the target fnOS device.

The workflow's latest matrix run passed for both versions, including core tests, syntax checks, FPK packaging, package inspection, and SHA-256 generation. Each job prints the exact resolved Node.js version and produces a separately named 14-day artifact:

- `fnos-nas-agent-test-fpk-node-24.x`
- `fnos-nas-agent-test-fpk-node-26.x`

The Node.js 26 device smoke test and green CI make 26 a reasonable candidate for the next test FPK. This does **not** prove that 26 is faster or uses less memory than 24, nor does a successful smoke test prove every app-center lifecycle path. Keep the 24.x matrix job as a compatibility regression check.

## What the workflow does

1. Sets up the matrix Node.js version on a GitHub-hosted Ubuntu x86_64 runner and bundles that executable in the app payload.
2. Generates valid PNG icons with a Python standard-library script and validates the required `config/privilege` and `config/resource` JSON plus `wizard/` directory.
3. Checks shell syntax and the Node.js entry point.
4. Downloads official `fnpack 1.2.3` and verifies its SHA-256 before executing it.
5. Builds the FPK, inspects its contents, and uploads the package plus checksum.

## Download the artifacts

Open the successful workflow run in the repository's **Actions** tab and download the artifact corresponding to the Node.js version you want to inspect. For the next fnOS test package, use the **Node 26.x** artifact; keep the Node 24.x artifact available as a fallback comparison.

## Network and safety boundary

The current test app is status-page-only and binds to `0.0.0.0` so computers and phones on the LAN can reach it. The only HTTP routes are the status page and `GET /api/health`; NAS command execution, Skill execution, and model calls remain disabled.

**Security note:** this status-only build has no client authentication. Binding to `0.0.0.0` listens on all network interfaces; it does not itself restrict access to the LAN. Use only on a trusted private LAN, do not configure router port forwarding, and do not expose port 18787 to the public internet. Before adding any NAS management or execution features, implement and test authentication, authorization, CSRF protections where applicable, and explicit confirmation for risky actions. A LAN-accessible status page is not a security boundary by itself.

## Follow-up real-device validation

Before treating an FPK as production-ready, validate install, start, status, stop, restart, and uninstall through the app center. Also confirm that the service listens on the intended interfaces and that `/api/health` returns HTTP 200 from a LAN client. A green CI build and a successful startup smoke test do not replace full lifecycle testing on the target fnOS version.

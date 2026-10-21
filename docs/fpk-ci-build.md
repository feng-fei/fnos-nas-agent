# FPK CI build

The repository builds the native x86 FPK on GitHub Actions; no build tools are installed on the NAS.

## Trigger

- Push changes affecting the app or build script to the FPK packaging, `fix/**`, or `test/**` branches.
- Or use **Actions → Build fnOS FPK → Run workflow**.

## Node.js compatibility matrix

The workflow tests two runtime lines in separate jobs:

- **Node.js 24.x LTS** — the stable baseline and preferred default until another version proves suitable.
- **Node.js 26.x Current** — a compatibility candidate; do not assume it is faster or more suitable just because it is newer.

Each job prints the exact resolved Node.js version and independently runs the core tests, syntax checks, FPK packaging, package inspection, and SHA-256 generation. Each produces a separately named 14-day artifact:

- `fnos-nas-agent-test-fpk-node-24.x`
- `fnos-nas-agent-test-fpk-node-26.x`

A green result means the current test suite and packaging checks pass for that runtime. It does **not** establish comparative runtime performance, nor prove installation and lifecycle behavior on a real fnOS device. The FPK embeds the Node.js executable resolved by that matrix job.

## What the workflow does

1. Sets up the matrix Node.js version on a GitHub-hosted Ubuntu x86_64 runner and bundles that executable in the app payload.
2. Generates valid PNG icons with a Python standard-library script and validates the required `config/privilege` and `config/resource` JSON plus `wizard/` directory.
3. Checks shell syntax and the Node.js entry point.
4. Downloads official `fnpack 1.2.3` and verifies its SHA-256 before executing it.
5. Builds the FPK, inspects its contents, and uploads the package plus checksum.

## Download the artifacts

Open the successful workflow run in the repository's **Actions** tab and download the artifact corresponding to the Node.js version you want to inspect.

## Network and safety boundary

The current test app is status-page-only and binds to `0.0.0.0` so computers and phones on the LAN can reach it. The only HTTP routes are the status page and `GET /api/health`; NAS command execution, Skill execution, and model calls remain disabled.

**Security note:** this status-only build has no client authentication. Binding to `0.0.0.0` listens on all network interfaces; it does not itself restrict access to the LAN. Use only on a trusted private LAN, do not configure router port forwarding, and do not expose port 18787 to the public internet. Before adding any NAS management or execution features, implement and test authentication, authorization, CSRF protections where applicable, and explicit confirmation for risky actions. A LAN-accessible status page is not a security boundary by itself.

## Follow-up real-device validation

On a test fnOS device, validate install, start, status, stop, restart, and uninstall through the app center. Also confirm that the service listens on the intended interfaces and that `/api/health` returns HTTP 200 from a LAN client. Do not treat a green CI build as a substitute for lifecycle testing on the target fnOS version.

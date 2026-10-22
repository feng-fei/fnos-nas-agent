# Development and Validation

> **Current implementation note (Phase 112):** Most core milestones are implemented in `main`, including mobile file operations, Skill review/import, model-provider management, and bounded task/audit workflows. Development and CI use Node.js 26.x. GitHub Actions builds and integrity-checks an unsigned x86 FPK test artifact; a separate least-privilege job attests verified `main` builds only. Real fnOS NAS lifecycle validation remains a separate manual staging gate.


## Development constraints

- Develop and test in a separate workstation or isolated workspace first.
- Do not modify a production NAS during development.
- Do not execute the supplied official Skill's scripts or binaries as part of static review.
- No API key, OAuth token, password, cookie, or NAS-specific secret belongs in Git.
- Prefer Node.js built-ins and keep the runtime dependency list small.

## Delivered milestones

All six milestones below are implemented in `main`. The code columns name the
delivered artifacts; the only remaining acceptance work is the manual
fnOS device gate described in [FPK test plan](fpk-test-plan.md).

### M1 — specification — delivered
- Architecture, security policy, Skill lifecycle, tool mapping, and acceptance criteria.
- No runtime code or NAS operations.

### M2 — core skeleton — delivered
- Node.js HTTP server with explicit configuration.
- Mobile-first static UI.
- Health/version endpoint.
- Authentication/session design and tests.
- No NAS adapter enabled by default.

### M3 — Skill manager — delivered
- Import ZIP into quarantine.
- Validate archive paths and size limits.
- Inventory and hash files.
- Review/approve/enable/disable states.
- No imported code execution.

### M4 — fnOS adapter — delivered
- Verify official `trim-cli` platform and invocation requirements.
- Implement a small allowlist of read-only commands first.
- Use structured arguments, timeouts, bounded output, and redaction.
- Keep write operations disabled until separately reviewed.

### M5 — model adapter and task orchestration — delivered
- Rule-based direct path for deterministic requests.
- Structured plans only; validate every proposed tool call.
- Limit plan steps, retries, duration, and model context.
- No model-controlled shell commands.

### M6 — FPK packaging — delivered in CI, device acceptance pending
- Verify current official fnOS app packaging documentation and supported `fnpack` version.
- Add manifest and lifecycle files only after confirming the official format.
- Build in an isolated environment.
- Test install, start, stop, upgrade, rollback, uninstall, and data retention on a test NAS.

## Supported platform

- **Architecture:** x86_64 only. The FPK `manifest` declares `platform = x86`,
  CI builds and smoke-tests the x86 artifact, and the bundled runtime is a Linux
  x86_64 Node.js 26.x build. Any other architecture needs its own tested
  runtime and artifact.
- **fnOS version:** the package targets the fnOS application-center third-party
  FPK format produced by the pinned `fnpack` 1.2.3 toolchain, and the launcher
  relies on the `TRIM_APPDEST`, `TRIM_PKGVAR`, and `TRIM_SERVICE_PORT`
  environment contract. CI does not pin or certify a specific fnOS release:
  the supported set is the fnOS versions that provide that contract and accept
  the `fnpack` 1.2.3 package format. A disposable test NAS must record the exact
  fnOS version, artifact SHA-256, test date, and pass/fail before a release is
  treated as device-validated.
- **Runtime:** Node.js 26.x, bundled inside the FPK as `app/bin/node`.

## Test strategy

- Unit tests for policy decisions, schemas, redaction, Skill archive validation, and lifecycle transitions.
- Negative tests for path traversal, malformed manifests, expired approvals, unknown tools, and oversized outputs.
- Adapter tests with a fake executable; no real NAS command required.
- Integration tests against a disposable test environment before production use.
- FPK smoke tests on a non-production fnOS instance.

## Release gate

A release is not ready until:
- all tests pass;
- no secrets are committed;
- security review covers every executable path;
- unknown tools fail closed;
- destructive operations remain denied by default;
- install/uninstall behavior and data retention are documented;
- supported fnOS versions and architecture are explicitly stated.

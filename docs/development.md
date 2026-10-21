# Development and Validation

> **Current implementation note:** This document records the original staged plan. Most core milestones are now implemented in `main`, including mobile file operations, Skill review/import, model-provider management, and bounded task/audit workflows. Development and CI use Node.js 26.x. FPK build/artifact/provenance checks and real fnOS NAS lifecycle validation remain paused until core development is stable and the user explicitly resumes release validation.


## Development constraints

- Develop and test in a separate workstation or isolated workspace first.
- Do not modify a production NAS during development.
- Do not execute the supplied official Skill's scripts or binaries as part of static review.
- No API key, OAuth token, password, cookie, or NAS-specific secret belongs in Git.
- Prefer Node.js built-ins and keep the runtime dependency list small.

## Planned milestones

### M1 — specification
- Architecture, security policy, Skill lifecycle, tool mapping, and acceptance criteria.
- No runtime code or NAS operations.

### M2 — core skeleton
- Node.js HTTP server with explicit configuration.
- Mobile-first static UI.
- Health/version endpoint.
- Authentication/session design and tests.
- No NAS adapter enabled by default.

### M3 — Skill manager
- Import ZIP into quarantine.
- Validate archive paths and size limits.
- Inventory and hash files.
- Review/approve/enable/disable states.
- No imported code execution.

### M4 — fnOS adapter
- Verify official `trim-cli` platform and invocation requirements.
- Implement a small allowlist of read-only commands first.
- Use structured arguments, timeouts, bounded output, and redaction.
- Keep write operations disabled until separately reviewed.

### M5 — model adapter and task orchestration
- Rule-based direct path for deterministic requests.
- Structured plans only; validate every proposed tool call.
- Limit plan steps, retries, duration, and model context.
- No model-controlled shell commands.

### M6 — FPK packaging
- Verify current official fnOS app packaging documentation and supported `fnpack` version.
- Add manifest and lifecycle files only after confirming the official format.
- Build in an isolated environment.
- Test install, start, stop, upgrade, rollback, uninstall, and data retention on a test NAS.

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

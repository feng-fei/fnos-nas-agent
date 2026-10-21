# fnos-nas-agent

A lightweight, self-hosted Agent for Feiniu OS (fnOS) NAS, designed around a mobile-friendly web interface, controlled NAS operations, and a reviewable Skill manager.

> **Status: Practical NAS functionality in progress.** Phases 2–44 are integrated on `main`; Phase 45 adds multi-provider model management, encrypted API-key storage, connection testing and runtime model switching on this feature branch. The Agent generates a terminal command but never runs the OAuth login or receives the one-time code. Task metadata persistence and crash recovery are implemented, and release gates cover the safety boundary. CI success is not equivalent to validation on a real fnOS NAS. The service includes password/session authentication, read-only diagnostics, Skill inventory/review and quarantined ZIP import, registered read-only and routine-write tools, one-time destructive-action confirmation, rules-first Agent routing, an optional server-configured model adapter, bounded asynchronous tasks, privacy-safe audit metadata, and FPK integrity/release checks. Task inputs, prompts, result payloads, and raw exceptions are never persisted in task history. Arbitrary command execution and imported Skill execution remain disabled. Development CI currently uses Node.js 26 core tests and syntax checks only; FPK build, checksum, artifact upload, and provenance jobs are temporarily paused while core capabilities stabilize.

## Goals

- Replace a heavier general-purpose Agent with a small Node.js-native service.
- Prefer deterministic rules for common read-only requests; use a remote model API only when needed.
- Import and inspect Skills without executing imported code during review.
- Require explicit confirmation for risky operations; deny destructive actions by default.
- Keep API keys, OAuth tokens, passwords, and sensitive output out of source control and logs.
- Package as an fnOS FPK only after validating the official packaging requirements.

## Current skeleton

- `src/server.mjs` — Node built-in HTTP server and health/tool endpoints.
- `src/config.mjs` — configuration validation; loopback-only default.
- `src/policy/registry.mjs` — empty, read-only-only tool registry.
- `src/web/index.html` — mobile-friendly status page.
- `tests/` — Node built-in test runner tests.
- `docs/phase-2.md` — current implementation boundary and acceptance checks.

No third-party runtime dependencies are required. **Node.js 26.x is the development and default packaged runtime** (latest patch in the 26.x line). Node.js 24 is no longer included in the development CI matrix. FPK packaging checks are temporarily paused; real fnOS validation remains a separate acceptance step.

## Run locally

```sh
npm test
npm start
```

Open `http://<NAS-IP>:18787` from a trusted LAN. On first run, set a management password (only a salted scrypt hash is stored), then log in. Authenticated users can view a read-only diagnostics snapshot and invoke three allowlisted read-only tools for system status, storage summary, and network interfaces. Arbitrary command execution, Skill execution, and model calls remain disabled. See [Phase 3 web authentication](docs/phase-3-web-auth.md) and [Phase 4 read-only diagnostics](docs/phase-4-read-only-diagnostics.md). HTTP is unencrypted; do not expose the service to untrusted networks or the public internet.

## Planned first capability

The official fnOS Skill is the first capability pack. Its reviewed archive can provide a platform-matched trim-cli binary, which the Agent exposes only through an allowlisted read-only adapter. OAuth uses the official interactive Authorization Code + PKCE flow: the user signs in and pastes the one-time code directly into the CLI terminal. The Agent never collects credentials or executes arbitrary Skill instructions. See [Phase 40 reviewed CLI installation](docs/phase-40-reviewed-cli-install.md), [Phase 42 connection health](docs/phase-42-cli-connection-health.md), and [Phase 43 guided OAuth setup](docs/phase-43-guided-oauth-setup.md).

## Design documents

- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [Skill lifecycle](docs/skill-lifecycle.md)
- [fnOS tool mapping](docs/fnos-tool-mapping.md)
- [Development plan](docs/development.md)
- [Phase 2 skeleton boundaries](docs/phase-2.md)
- [Phase 3 Skill Manager contract](docs/phase-3-skill-manager.md)
- [Phase 3 web authentication](docs/phase-3-web-auth.md)
- [Phase 5 Skill manager](docs/phase-5-skill-manager-api.md)
- [Phase 6 safe Skill ZIP import](docs/phase-6-skill-archive-import.md)
- [Phase 7 read-only tool registry](docs/phase-7-read-only-tool-registry.md)
- [Phase 8 Agent core and model routing](docs/phase-8-agent-core-model-routing.md)
- [Phase 9 operations task engine](docs/phase-9-operations-task-engine.md)
- [Phase 10 permission policy foundation](docs/phase-10-permission-policy-foundation.md)
- [Phase 11 static Skill manifest review](docs/phase-11-static-skill-manifest-review.md)
- [Phase 12 one-time approval ledger](docs/phase-12-one-time-approval-ledger.md)
- [Phase 13 mobile operations workbench](docs/phase-13-mobile-operations-workbench.md)
- [Phase 14 authentication security hardening](docs/phase-14-auth-security-hardening.md)
- [Phase 15 release readiness gates](docs/phase-15-release-readiness-gates.md)
- [Phase 16 FPK integration smoke tests](docs/phase-16-integration-smoke-tests.md)
- [Phase 17 HTTP authentication contract tests](docs/phase-17-http-auth-contract-tests.md)
- [Phase 18 FPK artifact integrity](docs/phase-18-fpk-artifact-integrity.md)
- [Phase 19 model adapter contract tests](docs/phase-19-model-adapter-contract-tests.md)
- [Phase 20 audit trail and operation trace](docs/phase-20-audit-trail.md)
- [Phase 21 task persistence and crash recovery](docs/phase-21-task-persistence-recovery.md)
- [Phase 22 release-candidate acceptance](docs/phase-22-release-candidate-acceptance.md)
- [Phase 24 release hygiene and fnOS smoke checks](docs/phase-24-release-hygiene-and-smoke-checks.md)
- [Phase 25 release manifest and build provenance](docs/phase-25-release-manifest-and-provenance.md)
- [Phase 26 release artifact verification](docs/phase-26-release-artifact-verification.md)
- [Phase 28 practical read-only file browser](docs/phase-28-practical-file-browser.md)
- [Phase 31 practical fnOS photo tools](docs/phase-31-fnos-photo-tools.md)
- [Phase 32 confirm-first action policy](docs/phase-32-confirm-first-action-policy.md)
- [Phase 33 practical routine file write tools](docs/phase-33-practical-file-write-tools.md)
- [Phase 34 confirmed destructive file actions](docs/phase-34-confirmed-destructive-file-actions.md)
- [Phase 35 Agent text-file creation](docs/phase-35-agent-text-file-creation.md)
- [Phase 36 bounded Agent file upload](docs/phase-36-bounded-agent-file-upload.md)
- [Phase 37 natural-language operations](docs/phase-37-natural-language-operations.md)
- [Phase 38 core integration and fast feedback](docs/phase-38-core-integration-fast-feedback.md)
- [Phase 39 official fnOS Skill archive compatibility](docs/phase-39-official-skill-archive-compatibility.md)
- [Phase 40 reviewed official CLI installation](docs/phase-40-reviewed-cli-install.md)
- [Phase 30 fnOS CLI path traversal guard](docs/phase-30-trim-cli-path-traversal-guard.md)
- [Phase 29 mobile fnOS read-only tool usability](docs/phase-29-mobile-fnos-tools.md)
- [Practical file management](docs/practical-file-management.md)
- [Skill and task management UX](docs/skill-and-task-management-ux.md)
- AI can browse allowed file metadata and preview bounded text files through validated read-only tools.
- [Phase 27 build provenance attestation](docs/phase-27-build-provenance-attestation.md)
- [FPK CI build and test artifact](docs/fpk-ci-build.md)
- [Security policy](SECURITY.md)

## Roadmap

1. **Specification** — architecture, risk tiers, Skill lifecycle, and tool contracts.
2. **Core skeleton** — minimal Node.js HTTP service, mobile UI, configuration, and tests.
3. **Skill manager** — inventory/review lifecycle and bounded ZIP import into quarantine (no extraction or execution).
4. **fnOS adapter** — a small set of verified read-only operations.
5. **Model adapter** — structured plans, schema validation, bounded retries, and token-saving routing.
6. **FPK packaging** — GitHub Actions builds a test FPK; then validate install/start/stop/upgrade/uninstall on a test fnOS system.

## License

No license has been selected yet. Until one is added, do not assume this repository grants permission to redistribute or reuse its code.


## Current safety boundary

Phase 11 reads only a bounded `SKILL.md` manifest from a validated archive for static review. It does not extract or execute imported content. Manifest findings are advisory. Routine file writes include registered folder creation, text-file creation, rename, move, and bounded Base64 upload tools. Deleting a single file or empty directory requires a target-bound, one-time confirmation; arbitrary shell execution and imported Skill execution remain disabled.


## Development notes

- [Phase 41 — Dynamic CLI Provider Integration Fix](docs/phase-41-trim-cli-provider-fix.md)
- [Phase 42 — CLI Connection Health](docs/phase-42-cli-connection-health.md)
- [Phase 43 — Guided Official CLI OAuth Setup](docs/phase-43-guided-oauth-setup.md)
- [Phase 44 — CLI Health and Read-only Closure](docs/phase-44-cli-health-and-readonly-closure.md)
- [Phase 45 — Model Provider Management](docs/phase-45-model-provider-manager.md)

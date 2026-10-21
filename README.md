# fnos-nas-agent

A lightweight, self-hosted Agent for Feiniu OS (fnOS) NAS, designed around a mobile-friendly web interface, controlled NAS operations, and a reviewable Skill manager.

> **Status: Phase 21 implementation in progress.** Phases 2–20 are integrated on `main`; the current branch adds bounded task-state persistence and crash recovery. The service includes password/session authentication, read-only diagnostics, Skill inventory/review and quarantined ZIP import, allowlisted read-only tools, rules-first Agent routing, an optional server-configured model adapter, bounded asynchronous tasks, privacy-safe audit metadata, and FPK integrity/release checks. Task inputs, prompts, result payloads, and raw exceptions are never persisted in task history. Arbitrary command execution and imported Skill execution remain disabled. Require Node.js 24/26 CI and Node.js 26 FPK packaging before merge.

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

No third-party runtime dependencies are required. **Node.js 26.x is the default packaged runtime** (latest patch in the 26.x line); Node.js 24.x is retained as a CI regression line. Upgrade to a newer major only after CI and fnOS validation.

## Run locally

```sh
npm test
npm start
```

Open `http://<NAS-IP>:18787` from a trusted LAN. On first run, set a management password (only a salted scrypt hash is stored), then log in. Authenticated users can view a read-only diagnostics snapshot and invoke three allowlisted read-only tools for system status, storage summary, and network interfaces. Arbitrary command execution, Skill execution, and model calls remain disabled. See [Phase 3 web authentication](docs/phase-3-web-auth.md) and [Phase 4 read-only diagnostics](docs/phase-4-read-only-diagnostics.md). HTTP is unencrypted; do not expose the service to untrusted networks or the public internet.

## Planned first capability

The supplied official fnOS Skill package is the first integration candidate. It documents using `trim-cli` and an OAuth 2.0 Authorization Code + PKCE flow. Exact command syntax, platform support, token handling, and permission requirements must be verified before implementation. A Skill's instructions are not permission to run arbitrary commands.

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
- [Phase 20 audit trail and operation trace](docs/phase-20-audit-trail.md)\n- [Phase 21 task persistence and crash recovery](docs/phase-21-task-persistence-recovery.md)
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

Phase 11 reads only a bounded `SKILL.md` manifest from a validated archive for static review. It does not extract or execute imported content. Manifest findings are advisory, and write/destructive execution remains disabled.

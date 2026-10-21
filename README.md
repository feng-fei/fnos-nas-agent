# fnos-nas-agent

A lightweight, self-hosted Agent for Feiniu OS (fnOS) NAS, designed around a mobile-friendly web interface, controlled NAS operations, and a reviewable Skill manager.

> **Status: Phase 2 skeleton.** A minimal Node.js HTTP service, mobile status page, configuration validation, and deny-by-default tool registry are present. No NAS commands are executed, no Skill code is executed, and no FPK has been built. Tests are written but have not been run in this GitHub-only workflow.

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

No third-party runtime dependencies are required. Node.js 20 or newer is required.

## Run locally

```sh
npm test
npm start
```

Open `http://127.0.0.1:8787`. The service binds to loopback by default. Non-loopback binding requires a long `AGENT_ACCESS_TOKEN`, but the current web page does not yet implement token entry. Do not expose it to a LAN or the public internet until an appropriate client authentication flow is implemented.

## Planned first capability

The supplied official fnOS Skill package is the first integration candidate. It documents using `trim-cli` and an OAuth 2.0 Authorization Code + PKCE flow. Exact command syntax, platform support, token handling, and permission requirements must be verified before implementation. A Skill's instructions are not permission to run arbitrary commands.

## Design documents

- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [Skill lifecycle](docs/skill-lifecycle.md)
- [fnOS tool mapping](docs/fnos-tool-mapping.md)
- [Development plan](docs/development.md)
- [Phase 2 skeleton boundaries](docs/phase-2.md)
- [Security policy](SECURITY.md)

## Roadmap

1. **Specification** — architecture, risk tiers, Skill lifecycle, and tool contracts.
2. **Core skeleton** — minimal Node.js HTTP service, mobile UI, configuration, and tests.
3. **Skill manager** — safe ZIP import, quarantine, inventory, hashing, review, and lifecycle.
4. **fnOS adapter** — a small set of verified read-only operations.
5. **Model adapter** — structured plans, schema validation, bounded retries, and token-saving routing.
6. **FPK packaging** — validate install/start/stop/upgrade/uninstall on a test fnOS system.

## License

No license has been selected yet. Until one is added, do not assume this repository grants permission to redistribute or reuse its code.

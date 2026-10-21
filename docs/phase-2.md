# Phase 2 — Minimal Node.js skeleton

## Included
- Node.js built-in HTTP server; no third-party runtime dependencies.
- Mobile-friendly status page, `GET /api/health`, and empty `GET /api/tools`.
- Configuration validation, deny-by-default tool registry, and Node built-in test runner.

## Safety boundaries
- Default bind address is `127.0.0.1`; not exposed to LAN by default.
- Non-loopback binding requires `AGENT_ACCESS_TOKEN` with at least 32 characters.
- Health check returns only non-sensitive status information.
- No shell execution, NAS adapter, Skill execution, model API, file import, or FPK scripts.
- The UI does not yet provide a token-entry workflow. Before LAN exposure, implement client authentication or use an authenticated reverse proxy.
- Do not port-forward this service to the public internet.

## Run locally
Requires Node.js 20 or newer.
```sh
npm test
npm start
```
Open `http://127.0.0.1:8787`.

## Acceptance checks
1. `npm test` passes.
2. Health endpoint returns `executionEnabled: false`.
3. Tool inventory is empty.
4. Invalid ports fail startup.
5. Non-loopback binding without a long token fails startup.
6. No secrets are committed and no third-party packages are required.

These checks are specified but have not been executed by this GitHub-only workflow.

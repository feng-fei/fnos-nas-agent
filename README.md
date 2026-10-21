# fnos-nas-agent

A lightweight, self-hosted Agent for Feiniu OS (fnOS) NAS. The project prioritizes a mobile-friendly control panel, practical file operations, model-provider management, and a reviewable Skill lifecycle.

## Current status

Core development is active. The repository currently includes:

- Password-based setup/login, sessions, read-only diagnostics, and metadata-only audit history.
- Mobile file browsing, bounded text preview, upload, folder creation, rename/move, batch operations, and confirmation-protected deletion.
- Rules-first Agent routing, allowlisted tool plans, bounded asynchronous tasks, progress reporting, task filtering/pagination, and queued-task cancellation.
- Encrypted multi-provider model configuration, catalog discovery, connection tests, fallback routing, bounded retries, and in-memory metrics.
- Provider presets for OpenAI, DeepSeek, SiliconFlow, Alibaba DashScope, Moonshot, Zhipu, OpenRouter, Google Gemini, Groq, and local Ollama.
- Quarantined ZIP Skill import, bounded static manifest review, lifecycle transitions, bulk review, and reviewed installation of the official fnOS CLI.
- Privacy-conscious audit records that omit prompts, task inputs, credentials, and raw exceptions.

**Runtime and validation:** Node.js 26.x is the supported development and CI runtime. CI success does not mean the app has been installed or validated on a real fnOS NAS. FPK build, checksum, artifact upload, and provenance jobs remain paused while core capabilities stabilize. No real NAS is contacted by the automated tests.

## Safety boundaries

- Arbitrary shell execution remains disabled.
- Imported Skill code is never executed as part of ZIP import or static review.
- Risky file actions require a target-bound, one-time confirmation.
- Model output can only request registered tools; the Agent validates tool IDs and arguments before invocation.
- API keys are encrypted at rest by the model-provider store and are not returned to the UI.
- Task inputs, prompts, result payloads, and raw exceptions are not persisted to task history.
- HTTP is unencrypted. Keep the service on a trusted network; do not expose it directly to the public internet.

Static manifest findings are advisory and are not a security certification. See [Security model](docs/security.md), [Architecture](docs/architecture.md), and [Security policy](SECURITY.md).

## Run locally

Use Node.js 26.x and run:

```sh
npm test
npm start
```

Open `http://<NAS-IP>:18787` from a trusted LAN. On first run, set a management password; only a salted scrypt hash is stored. Log in to access diagnostics and the mobile management UI.

The project aims to minimize runtime dependencies and primarily uses Node.js built-ins. Review `package.json` for the current scripts.

## Remote access from a phone

For access away from the local network, prefer a private VPN such as Tailscale or WireGuard. Do not port-forward the Agent's HTTP port directly to the public internet. See [Private remote access](docs/private-remote-access.md).

## Official fnOS CLI setup

The reviewed official fnOS Skill archive can provide a platform-matched `trim-cli` binary. The Agent exposes only registered read-only CLI operations. OAuth uses the official interactive Authorization Code + PKCE flow: sign in through your own browser and paste the one-time code directly into the CLI terminal. The Agent does not collect passwords, authorization codes, or tokens.

See [Phase 40 — Reviewed CLI installation](docs/phase-40-reviewed-cli-install.md), [Phase 42 — CLI connection health](docs/phase-42-cli-connection-health.md), and [Phase 43 — Guided OAuth setup](docs/phase-43-guided-oauth-setup.md).

## Development and validation

- Node.js 26.x core tests and syntax checks run in GitHub Actions.
- Provider integrations use fake endpoints in automated tests; CI does not call real model services.
- Skill ZIP tests validate structure and static review only; imported content is not executed.
- FPK packaging and real fnOS lifecycle validation are separate release tasks and remain paused.

Contributions should include focused tests, bounded inputs/outputs, sanitized errors, and documentation for new capabilities. Do not add secrets or run development tests against a production NAS.

## Design documents

### Current capabilities
- [Practical file management](docs/practical-file-management.md)
- [Mobile file search and sorting](docs/phase-79-mobile-file-search-sort.md)
- [Skill lifecycle](docs/skill-lifecycle.md)
- [Skill archive upload progress and cancellation](docs/phase-80-skill-archive-upload-progress.md)
- [Sequential multi-Skill ZIP import](docs/phase-81-multi-skill-upload.md)
- [Mobile file navigation breadcrumbs](docs/phase-82-file-breadcrumbs.md)
- [Sequential mobile multi-file upload](docs/phase-83-mobile-multi-file-upload.md)
- [File browser pagination](docs/phase-84-file-browser-pagination.md)
- [File transfer HTTP integration](docs/phase-85-file-transfer-http-integration.md)
- [Skill import HTTP integration](docs/phase-86-skill-import-http-integration.md)
- [Skill and task management UX](docs/skill-and-task-management-ux.md)
- [fnOS tool mapping](docs/fnos-tool-mapping.md)
- [Phase 45 — Model Provider Management](docs/phase-45-model-provider-manager.md)
- [Phase 46 — Model Provider Reliability](docs/phase-46-model-reliability.md)
- [Phase 47 — Bounded Conversation Context](docs/phase-47-conversation-context.md)
- [Phase 48 — Bounded Task Progress](docs/phase-48-task-progress.md)
- [Phase 49 — Bounded Batch File Operations](docs/phase-49-batch-file-operations.md)
- [Mobile task progress UI](docs/phase-50-mobile-task-progress-ui.md)
- [Authenticated batch file operations API](docs/phase-51-batch-files-api.md)
- [Model catalog discovery](docs/phase-53-model-catalog-discovery.md)
- [Expanded provider presets](docs/phase-54-provider-presets-expansion.md)
- [Mobile Skill search and filters](docs/phase-55-skill-search-filters.md)
- [Local Ollama provider](docs/phase-56-local-ollama-provider.md)
- [Inline model catalog picker](docs/phase-57-model-catalog-picker.md)
- [Task history filters and pagination](docs/phase-58-task-history-filters.md)
- [Bulk Skill review API](docs/phase-59-bulk-skill-review.md)
- [Mobile bulk Skill review](docs/phase-60-bulk-skill-review-ui.md)
- [Mobile task history controls](docs/phase-61-task-history-mobile-ui.md)
- [Model retry resilience](docs/phase-62-model-adapter-error-resilience.md)
- [Static Skill review hardening](docs/phase-63-skill-archive-review-hardening.md)
- [Task history cleanup](docs/phase-64-clear-terminal-task-history.md)
- [Filtered audit history](docs/phase-65-audit-history-mobile-ui.md)
- [Task history cleanup control](docs/phase-66-task-history-cleanup-ui.md)
- [Task result details](docs/phase-67-task-result-details.md)
- [Gemini and Groq presets](docs/phase-68-gemini-groq-presets.md)
- [Bounded batch model connection testing](docs/phase-91-model-batch-test.md)
- [Persisted model connection-test latency](docs/phase-92-model-test-latency.md)
- [Model connection test diagnostics](docs/phase-93-model-test-diagnostics-ui.md)
- [Bounded task result retention](docs/phase-69-bounded-task-results.md)
- [Model action rate limiting](docs/phase-76-model-action-rate-limit.md)
- [Mobile upload progress](docs/phase-77-mobile-upload-progress.md)
- [Mobile upload cancellation](docs/phase-78-cancel-file-upload.md)

### Foundations
- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [Development plan](docs/development.md)
- [Phase 2 — Skeleton boundaries](docs/phase-2.md)
- [Phase 3 — Web authentication](docs/phase-3-web-auth.md)
- [Phase 6 — Safe Skill ZIP import](docs/phase-6-skill-archive-import.md)
- [Phase 8 — Agent core and model routing](docs/phase-8-agent-core-model-routing.md)
- [Phase 10 — Permission policy foundation](docs/phase-10-permission-policy-foundation.md)
- [Phase 11 — Static Skill manifest review](docs/phase-11-static-skill-manifest-review.md)
- [Phase 12 — One-time approval ledger](docs/phase-12-one-time-approval-ledger.md)
- [Phase 14 — Authentication security hardening](docs/phase-14-auth-security-hardening.md)
- [Phase 20 — Audit trail](docs/phase-20-audit-trail.md)
- [Phase 21 task persistence and crash recovery](docs/phase-21-task-persistence-recovery.md)
- [Phase 22 release-candidate acceptance](docs/phase-22-release-candidate-acceptance.md)
- [Phase 27 build provenance attestation](docs/phase-27-build-provenance-attestation.md)
- [Phase 28 practical read-only file browser](docs/phase-28-practical-file-browser.md)
- [Phase 43 guided OAuth setup](docs/phase-43-guided-oauth-setup.md)
- [Phase 44 — CLI Health and Read-only Closure](docs/phase-44-cli-health-and-readonly-closure.md)
- [Phase 39 — Official Skill archive compatibility](docs/phase-39-official-skill-archive-compatibility.md)
- [FPK CI build and test artifact](docs/fpk-ci-build.md)
- [FPK test plan](docs/fpk-test-plan.md)

## License

No license has been selected yet. Until one is added, do not assume this repository grants permission to redistribute or reuse its code.

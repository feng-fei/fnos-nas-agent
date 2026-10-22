# fnos-nas-agent

A lightweight, self-hosted Agent for Feiniu OS (fnOS) NAS. The project prioritizes a mobile-friendly control panel, practical file operations, model-provider management, and a reviewable Skill lifecycle.

## Current status

Core development is active. The repository currently includes:

- Password-based setup/login, sessions, read-only diagnostics, and metadata-only audit history.
- Mobile file browsing, bounded text preview, upload, folder creation, rename/move, batch operations, and confirmation-protected deletion.
- The mobile file browser can calculate SHA-256 for files up to 256 MiB with streaming reads, root confinement, and a per-session request limit.
- Rules-first Agent routing, allowlisted tool plans, bounded asynchronous tasks, progress reporting, task filtering/pagination, queued-task cancellation, and cooperative cancellation of running tasks (HTTP 202).
- Encrypted multi-provider model configuration, catalog discovery, connection tests, fallback routing, bounded retries, and in-memory metrics.
- Provider presets for OpenAI, DeepSeek, SiliconFlow, Alibaba DashScope, Moonshot, Zhipu, OpenRouter, Google Gemini, Groq, local Ollama, and a custom OpenAI-compatible endpoint.
- Quarantined ZIP Skill import, bounded static manifest review, lifecycle transitions, bulk review, and reviewed installation of the official fnOS CLI.
- GitHub branch/tag ZIP imports are validated, bounded, and stored in quarantine before static review.
- Batch-import up to five GitHub Skills sequentially with immutable commit pinning and a shared 25 MiB download budget; each item remains in quarantine for review.
- Imported Skill archives receive bounded source-code heuristics for risky shell execution, dynamic evaluation, privilege escalation, destructive commands, and sensitive-file access before human review.
- Skill static review also checks common cloud access-key IDs, GitHub/package-registry tokens, private-key markers, and long credential assignments; findings store paths and rule names only, never matched values.
- Reviewers can browse quarantined Skill file paths and preview supported UTF-8 source/config text in memory (64 KiB per file), without extracting or executing imported content.
- GitHub Skill source labels retain the repository and branch/tag ref when importing a specific archive.
- Privacy-conscious audit records that omit prompts, task inputs, credentials, and raw exceptions.
- A registrable tool registry: the built-in fnOS tools, Skill tools and MCP server tools share one catalogue, and every tool keeps the origin it was registered with.
- An MCP client over the stdio transport with a declarative server configuration; a server that fails is reported and never blocks the built-in tools.
- A Skill package parser that reads the canonical package layout in memory and reports every deviation as a named finding, without extracting or executing anything.
- A dangerous command rule pack that judges shell, PowerShell, Python and Node.js constructs identically in the manifest review, the source review and the command scanner.
- Tool call observability: every invocation is traced with its identity, timing, outcome and a fixed error classification, and a structured JSON logger drops secret-looking fields.
- A Marvis style conversation window with bubbles, a multi-line composer, tool cards, an inline approval, a stop button and a streamed progress.
- A direct chat channel: the model answers in plain text over a streamed HTTP response, under the same origin, session, rate limit and endpoint whitelist rules as the rest of the product.
- A dual-mode chat window: the operator switches between the task mode and the direct chat mode, and the direct mode streams a plain text answer instead of creating a NAS task.
- A model settings surface: an API key is shown as a fingerprint, the password never comes back in clear text while it is edited, and a failed save names the field that caused it.
- A tool call observer: the built-in catalogue, the agent plan and the external MCP tools all leave a trace entry, so a real run produces the same evidence the tests do.
- An MCP tool bridge: a tool of a foreign server enters the catalogue under a namespaced identifier (`mcp__server__tool`), the risk comes from the tool name alone, an unknown name is treated as destructive, and a write or destructive tool needs a one time approval while the read-only mode and the kill switch still cover it (Phases 147, 148, 153).
- A migration record that maps every migrated Marvis capability to its implementation, its phase and its file, next to the naming and risk rules of the bridge, the red lines of the round and the limits that are still open (Phase 156).
- A read-only observation surface: the system snapshot reports the real state of the machine and marks an unmeasured section as unknown, the security inspection turns the audit log into a report, the model usage counts the requests and tokens without keeping a prompt, and the diagnostic report ranks the likely causes and filters every destructive suggestion (Phases 160–166).
- An MCP stdio entry point: an external client can discover the read-only tool catalogue over JSON-RPC 2.0, under the same tool contract and risk rules as the HTTP side (Phases 164, 166).
- A verified write pipeline: a write action is registered with its target and its approval level, runs its steps in order, keeps a record of what happened and can undo the actions of the same run (Phase 171).
- A closed-by-default network policy: every outbound URL is judged before the request and before every redirect hop, so an unknown destination is never contacted (Phase 172).
- A diagnosis history that keeps the past reports, groups them by conclusion and absorbs a human correction (Phase 173).
- An observation panel on the overview page: the workflow plans, the runbooks and the last diagnostic evidence are shown side by side, read-only (Phase 174).
- A controlled web fetch: only the allowed content types are read, the body is capped, the raw page is never returned and the credentials in a URL are removed from the error (Phase 175).
- Read-only exits for the diagnosis history, the write action registry, the network policy and the controlled fetch, all behind the same session and origin rules (Phase 176).
- A source-aware knowledge base: every entry keeps its source, its collection time and its open conflicts, and the panel cites the entry it shows instead of presenting a stored fact as the live state (Phase 177).
- Structured network diagnostics: link state, latency samples and DNS answers become a verdict with explicit gaps, so "the network is slow" is answerable without guesswork (Phase 178).
- A knowledge panel with a read-only application inventory and a notification centre that merges exceptions, approvals and finished tasks, hiding credentials before display (Phase 179).
- Per-container Docker advice with a reason, a severity and a next step, produced from collected data without touching Docker (Phase 180).
- A Skill archive structure verdict stored next to the source review: references, scripts and tests are counted, an incomplete package is never recorded as complete, and a hand-edited verdict can never claim the server reviewed it (Phase 187).
- Disk capacity trends: samples are de-duplicated per hour, capped and stored atomically, and a fill date is only predicted when the growth rate and the sample count support it (Phase 188/191).
- A batch rename that plans first: four modes, four conflict classes checked before anything moves, and an ordered rollback if a step fails halfway (Phase 189/191).
- Service state read through one fixed command shape: a server-side unit whitelist, `systemctl show` with fixed argv and no shell, and `unknown` whenever the collector cannot measure — never a guessed `running` (Phase 190/191).
- Device temperature from `/sys/class/thermal`: strict milli-Celsius parsing, per-sensor de-duplication, and `unknown` instead of `0 °C` when nothing credible was measured (Phase 193/196/197).
- System events from the log tail: kmsg, journalctl-short and `LEVEL:` lines are normalised, repeats are grouped, and the log is graded ok/warning/critical — with dropped lines accounted for exactly (Phase 194/196/197).
- SMART health that never guesses: the ATA attribute table is parsed for reallocated/pending/offline sectors, CRC errors and temperature; a disc that cannot be read is `unknown`, and `smartctl` stays off unless `FNOS_AGENT_SMART_COLLECTOR=on` (Phase 192/197).
- An upgrade check that does not phone home: strict SemVer comparison against a version the caller supplies, `unknown` when either side cannot be parsed, and downgrades are never offered (Phase 195/197).

**Runtime and validation:** Node.js 26.x is the supported development and CI runtime. GitHub Actions builds an unsigned x86 CI test FPK, inspects the archive, verifies SHA-256 and release-manifest consistency, and uploads the artifact for 14 days. A separate job creates GitHub build-provenance attestation only for verified `main` builds; pull requests do not receive OIDC/attestation permissions. CI success does not mean the package has been installed or validated on a real fnOS NAS; lifecycle acceptance remains a separate manual staging gate.

## Safety boundaries

- Arbitrary shell execution remains disabled.
- Imported Skill code is never executed as part of ZIP import or static review.
- Risky file actions require a target-bound, one-time confirmation. The confirmation is held by the server, bound to the session that asked for it, and cannot be minted by the client.
- A global read-only mode and a kill switch block every mutating tool call. An operator can flip them from the console or through `GET`/`POST /api/execution-mode`.
- The first-run setup needs an installation code when the request does not come from the appliance itself, so an unconfigured instance cannot be claimed from the LAN.
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
- FPK build and artifact-integrity checks run in CI; real fnOS install/upgrade/rollback/uninstall validation remains a separate manual staging gate.

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
- [Phase 144 — Skill Package Format](docs/phase-144-skill-package-format.md)
- [Phase 145 — Dangerous Command Rule Pack](docs/phase-145-dangerous-command-rules.md)
- [Phase 146 — Tool Call Observability](docs/phase-146-tool-trace.md)
- [Phase 146 — Task Event Stream](docs/phase-146-task-events.md)
- [Phase 147 — Registrable Tool Registry](docs/phase-147-tool-registry.md)
- [Phase 148 — MCP Client](docs/phase-148-mcp-client.md)
- [Phase 149 — Marvis Style Conversation Window](docs/phase-149-chat-window.md)
- [Phase 150 — Model Chat Adapter](docs/phase-150-model-chat-adapter.md)
- [Phase 151 — Direct Chat Channel over HTTP](docs/phase-151-direct-chat-http.md)
- [Phase 151 — Dual-mode Chat Window](docs/phase-151-chat-direct-mode.md)
- [Phase 153 — MCP Tool Bridge](docs/phase-153-mcp-tool-bridge.md)
- [Phase 154 — Model Settings UI](docs/phase-154-model-settings-ui.md)
- [Phase 155 — Tool Call Observer](docs/phase-155-tool-call-observer.md)
- [Phase 156 — Marvis Migration Integration](docs/phase-156-marvis-migration-integration.md)
- [Phase 157 — UI Integration Verification](docs/phase-157-ui-integration.md)
- [Phase 158 — Windows Absolute Path Guard](docs/phase-158-windows-absolute-path.md)
- [Phase 160 — Security Audit Report](docs/phase-160-security-audit.md)
- [Phase 161 — System Snapshot](docs/phase-161-system-snapshot.md)
- [Phase 162 — Diagnostics](docs/phase-162-diagnostics.md)
- [Phase 163 — Duplicate Detector](docs/phase-163-duplicate-detector.md)
- [Phase 164 — MCP Server](docs/phase-164-mcp-server.md)
- [Phase 165 — Model Usage](docs/phase-165-model-usage.md)
- [Phase 166 — Agent Insights](docs/phase-166-agent-insights.md)
- [Phase 167 — Diagnostic Evidence](docs/phase-167-diagnostic-evidence.md)
- [Phase 168 — Workflow Engine](docs/phase-168-workflow-engine.md)
- [Phase 169 — Runbook Store](docs/phase-169-runbook-store.md)
- [Phase 170 — Observation Routes](docs/phase-170-observation-routes.md)- [Phase 171 — Verified Write Pipeline](docs/phase-171-verified-write.md)
- [Phase 172 — Network Egress Policy](docs/phase-172-network-policy.md)
- [Phase 173 — Diagnosis History](docs/phase-173-diagnosis-history.md)
- [Phase 174 — Observation Panel](docs/phase-174-observation-panel.md)
- [Phase 175 — Controlled Web Fetch](docs/phase-175-web-fetch.md)
- [Phase 176 — Diagnosis and Policy Routes](docs/phase-176-diagnosis-and-policy-routes.md)
- [Phase 177 — Knowledge Base](docs/phase-177-knowledge-base.md)
- [Phase 178 — Network Diagnostics](docs/phase-178-network-diagnostics.md)
- [Phase 179 — Knowledge Panel and Notifications](docs/phase-179-knowledge-and-notifications.md)
- [Phase 180 — Docker Advisor](docs/phase-180-docker-advisor.md)
- [Phase 187 — Skill Package Review](docs/phase-187-skill-package-review.md)
- [Phase 188 — Capacity Trend Forecast](docs/phase-188-capacity-forecast.md)
- [Phase 189 — Batch Rename Planner](docs/phase-189-batch-rename.md)
- [Phase 190 — Service Status Parsing](docs/phase-190-service-status.md)
- [Phase 191 — Runtime Wiring](docs/phase-191-runtime-wiring.md)
- [Phase 192 — SMART Health](docs/phase-192-smart-health.md)
- [Phase 193 — Thermal Status](docs/phase-193-thermal-status.md)
- [Phase 194 — System Events](docs/phase-194-system-events.md)
- [Phase 195 — Update Check](docs/phase-195-update-check.md)
- [Phase 196 — Collectors](docs/phase-196-collectors.md)
- [Phase 197 — Device Diagnosis](docs/phase-197-device-diagnosis.md)
- [Phase 198 — Certificate Check](docs/phase-198-certificate-check.md)
- [Phase 199 — Idempotency](docs/phase-199-idempotency.md)
- [Phase 201 — Deployment Precheck](docs/phase-201-deployment-precheck.md)
- [Phase 202 — Deploy, Certificate and Idempotency Wiring](docs/phase-202-deploy-cert-wiring.md)

- [Phase 94 — Model Catalog HTTP Integration](docs/phase-94-model-catalog-http.md)
- [Phase 95 — Searchable Model Catalog Picker](docs/phase-95-model-catalog-search.md)
- [Phase 96 — Task History Search](docs/phase-96-task-history-search.md)
- [Phase 97 — GitHub Skill Archive Import](docs/phase-97-github-skill-archive-import.md)
- [Phase 98 — Direct Natural-Language fnOS Queries](docs/phase-98-fnos-query-intents.md)
- [Phase 99 — GitHub Repository URL Shortcut](docs/phase-99-github-repo-shortcut.md)
- [Phase 100 — Skill Source Provenance](docs/phase-100-skill-source-provenance.md)
- [Phase 101 — Expanded Official fnOS Read-only Operations](docs/phase-101-official-readonly-tools.md)
- [Phase 102 — Immutable GitHub Skill Commit Pinning](docs/phase-102-pin-skill-commit.md)
- [Phase 103 — Bounded Skill Source Static Review](docs/phase-103-skill-source-static-review.md)
- [Phase 104 — Batch GitHub Skill Import](docs/phase-104-batch-github-skill-import.md)
- [Phase 105 — Skill Embedded Credential Scanning](docs/phase-105-skill-secret-scanning.md)
- [Phase 106 — Running Task Cancellation API](docs/phase-106-running-task-cancel-api.md)
- [Phase 107 — Quarantined Skill Source Preview](docs/phase-107-skill-quarantine-source-preview.md)
- [Phase 108 — File SHA-256 Checksum](docs/phase-108-file-sha256-checksum.md)
- [Phase 118 — File Read Descriptor Confinement](docs/phase-118-file-read-descriptor-confinement.md)
- [Phase 120 — File Browser Directory Descriptor Confinement](docs/phase-120-file-browser-directory-descriptor-confinement.md)
- [Phase 110 — Approval Queue Revocation Consistency](docs/phase-110-approval-queue-consistency.md)
- [Phase 111 — Task Snapshot Persistence Retry](docs/phase-111-task-persistence-retry.md)
- [Phase 112 — FPK CI Build and Artifact Verification](docs/phase-112-fpk-ci-build-and-artifact-verification.md)

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
- [Phase 113 — FPK Lifecycle Process Identity](docs/phase-113-fpk-process-identity.md)
- [Phase 114 — FPK Build Provenance Attestation](docs/phase-114-build-provenance-attestation.md)
- [Phase 121 — Recoverable Session Persistence](docs/phase-121-session-persistence-retry.md)
- [Phase 122 — File Mutation Directory Descriptor Confinement](docs/phase-122-file-write-directory-descriptor-confinement.md)
- [Phase 125 — Skill Quarantine Directory Descriptor Confinement](docs/phase-125-skill-quarantine-directory-descriptor-confinement.md)
- [Phase 123 — Bundled Runtime FPK Lifecycle Smoke](docs/phase-123-fpk-bundled-runtime-smoke.md)
- [Phase 124 — Recoverable Skill Inventory Persistence](docs/phase-124-skill-store-persistence-retry.md)
- [Phase 115 — Immutable GitHub Actions References](docs/phase-115-github-actions-pinning.md)
- [Phase 116 — Post-signing Attestation Verification](docs/phase-116-attestation-verification.md)
- [Phase 117 — FPK Lifecycle Smoke Verification](docs/phase-117-fpk-lifecycle-smoke.md)
- [Phase 119 — Expired Session Cleanup Error Handling](docs/phase-119-expired-session-cleanup.md)
- [Phase 28 practical read-only file browser](docs/phase-28-practical-file-browser.md)
- [Phase 43 guided OAuth setup](docs/phase-43-guided-oauth-setup.md)
- [Phase 44 — CLI Health and Read-only Closure](docs/phase-44-cli-health-and-readonly-closure.md)
- [Phase 39 — Official Skill archive compatibility](docs/phase-39-official-skill-archive-compatibility.md)
- [FPK CI build and test artifact](docs/fpk-ci-build.md)
- [FPK test plan](docs/fpk-test-plan.md)
- [Phase 126 — Execution Policy](docs/phase-126-execution-policy.md)
- [Phase 127 — Destructive Capability](docs/phase-127-destructive-capability.md)
- [Phase 128 — Audit Log Hardening](docs/phase-128-audit-log-hardening.md)
- [Phase 129 — State File Recovery](docs/phase-129-state-file-recovery.md)
- [Phase 130 — Release Consistency](docs/phase-130-release-consistency.md)
- [Phase 131 — Server Hardening](docs/phase-131-server-hardening.md)
- [Phase 132 — Real NAS Staging Acceptance](docs/phase-132-nas-staging-acceptance.md)
- [Phase 133 — Model Fallback and Scan Bounds](docs/phase-133-model-fallback-and-scan-bounds.md)
- [Phase 134 — Overview Service](docs/phase-134-overview-service.md)
- [Phase 135 — Mobile First User Interface](docs/phase-135-mobile-first-user-interface.md)
- [Phase 136 — Skill Trust Hardening](docs/phase-136-skill-trust-hardening.md)
- [Phase 139 — Reverse Proxy Deployment](docs/phase-139-reverse-proxy-deployment.md)
- [Phase 137 — Task and Approval Lifecycle](docs/phase-137-task-approval-lifecycle.md)
- [Phase 138 — File Domain Hardening](docs/phase-138-file-domain-hardening.md)
- [Phase 140 — Model Provider Resilience](docs/phase-140-model-provider-resilience.md)
- [Phase 141 — Official Skill Identity](docs/phase-141-official-skill-identity.md)
- [Phase 142 — Official CLI Manifest Paths](docs/phase-142-official-cli-manifest-paths.md)
- [Phase 143 — Official CLI Login Guidance](docs/phase-143-cli-login-required.md)
- [Phase 144 — Skill Package Format](docs/phase-144-skill-package-format.md)
- [Phase 145 — Dangerous Command Rule Pack](docs/phase-145-dangerous-command-rules.md)
- [Phase 146 — Tool Call Observability](docs/phase-146-tool-trace.md)
- [Phase 146 — Task Event Stream](docs/phase-146-task-events.md)
- [Phase 147 — Registrable Tool Registry](docs/phase-147-tool-registry.md)
- [Phase 148 — MCP Client](docs/phase-148-mcp-client.md)
- [Phase 149 — Marvis Style Conversation Window](docs/phase-149-chat-window.md)
- [Phase 150 — Model Chat Adapter](docs/phase-150-model-chat-adapter.md)
- [Phase 151 — Direct Chat Channel over HTTP](docs/phase-151-direct-chat-http.md)
- [Phase 151 — Dual-mode Chat Window](docs/phase-151-chat-direct-mode.md)
- [Phase 153 — MCP Tool Bridge](docs/phase-153-mcp-tool-bridge.md)
- [Phase 154 — Model Settings UI](docs/phase-154-model-settings-ui.md)
- [Phase 155 — Tool Call Observer](docs/phase-155-tool-call-observer.md)
- [Phase 156 — Marvis Migration Integration](docs/phase-156-marvis-migration-integration.md)
- [Documentation index](docs/README.md)

## License

This project is released under the MIT License. The full terms are in [LICENSE](LICENSE).

Unless a file states otherwise, you may use, copy, modify, merge, publish, distribute, sublicense, and sell copies of this project and its documentation, provided the copyright notice and the permission notice are retained. The software is provided "as is", without warranty of any kind.

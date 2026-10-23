# Documentation index

Every design and delivery document in this repository. Phase numbers are
historical iteration identifiers: they are **not guaranteed to be continuous or
unique** — a few numbers were reused for parallel work, and some early
iterations were never given a number. The filenames are the stable reference.

This index lists 219 documents (203 phase documents and 15 non-phase documents, plus this file).

## Non-phase documents

- [Architecture](architecture.md) — Build a small, self-hosted fnOS NAS Agent distributed as an FPK. The first release prioritizes a mobile-friendly LAN web console, low-token task routing, and tightly controlled access to…
- [Marvis remaining work](marvis-remaining-work.md) — 清单剩余项的逐条现状与下一步（2026-10-22 盘点：Implemented 67 / Partly 123 / Partial 4 / Open 49），供下一轮挑选迁移顺序。
- [Development and Validation](development.md) — All six milestones below are implemented in main. The code columns name the delivered artifacts; the only remaining acceptance work is the manual fnOS device gate described in FPK test plan.
- [fnOS Official Skill Tool Mapping](fnos-tool-mapping.md) — The supplied official fnOS Skill ZIP is the reference for task instructions and trim-cli usage. This document is a design mapping, not a claim that each command has already been validated…
- [FPK CI build](fpk-ci-build.md) — GitHub Actions builds an unsigned x86 CI test FPK from an isolated copy of apps/fnos-nas-agent/. On main, a separate job additionally produces a GitHub artifact attestation for the FPK…
- [Native FPK validation plan](fpk-test-plan.md) — Official reference material:
- [Official fnOS trim-cli read-only adapter](official-trim-cli-adapter.md) — The Agent integrates the official trim-cli as an optional capability provider. An explicit TRIM_CLI_PATH override takes precedence; otherwise the Agent uses the CLI installed from the…
- [Marvis feature checklist](marvis-feature-checklist.md) — The product checklist this repository is migrating against: sixteen modules with numbered items (A01–A15, S01–S20, D01–D15, F01–F25, C01–C15, APP01–APP18, N01–N12, SEC01–SEC18, W01–W16, B01–B10, AI01–AI14, K01–K10, R01–R10, SK01–SK12, UI01–UI18, O01–O15), the priority model and the delivery order. It is the reference the capability matrix measures against.
- [Marvis capability matrix](marvis-capability-matrix.md) — Every numbered item of the Marvis feature checklist with its state in this repository, the phase and the file that implements it, and the gap that is still open. This is the trace between the checklist and the code.
- [Marvis-inspired feature parity](marvis-feature-parity.md) — Translate Marvis-style file, system, knowledge, automation, and cross-device capabilities into a security-first fnOS NAS roadmap; document the bounded text-content search milestone.
- [Practical file management](practical-file-management.md) — Extends the authenticated mobile file browser with bounded UTF-8 text preview, streaming downloads, binary uploads up to 25 MiB, folder creation, rename, move, and delete.
- [Private remote access from a phone](private-remote-access.md) — The Agent is a self-hosted web service. For access away from home, use a private VPN overlay such as Tailscale or WireGuard rather than exposing port 18787 directly to the internet.
- [Security Model](security.md) — Examples: show Agent version, show enabled Skills, display task history metadata. No NAS mutation.
- [Skill and task management UX](skill-and-task-management-ux.md) — This change completes two practical UI gaps:
- [Skill Lifecycle](skill-lifecycle.md) — The Skill manager supports importing and managing capability packages while keeping the Agent core independent. v0.1 treats Skills as declarative instruction/documentation packages. It does…

## Phase documents


### Phase 2

- [Phase 2 — Minimal Node.js skeleton](phase-2.md) — Requires Node.js 20 or newer. Open http://127.0.0.1:8787.

### Phase 3

- [Phase 3 — Skill Manager Contract](phase-3-skill-manager.md) — This phase adds a reviewable Skill inventory and lifecycle. It does not execute imported Skill code, install dependencies, invoke shell scripts, or grant NAS privileges. Node.js 26.x is the…
- [Web authentication foundation (Phase 3)](phase-3-web-auth.md) — The setup endpoint is exposed to the trusted LAN only because the first-run token does not exist yet. A device already on that LAN could race to complete setup. Therefore, only use this…

### Phase 4

- [Phase 4: Read-only NAS diagnostics](phase-4-read-only-diagnostics.md) — The authenticated GET /api/diagnostics endpoint reports a bounded snapshot using Node.js built-ins only:

### Phase 5

- [Phase 5: Skill inventory and review lifecycle](phase-5-skill-manager-api.md) — pending_review -> approved | rejected

### Phase 6

- [Phase 6: Safe Skill ZIP import and quarantine](phase-6-skill-archive-import.md) — The archive is stored as <app-data>/skill-quarantine/<sha256>.zip with restrictive directory/file permissions (0700/0600). Inventory records include the verified digest, relative quarantine…

### Phase 7

- [Phase 7: Read-only tool registry](phase-7-read-only-tool-registry.md) — Expose a small, explicit allowlist of built-in read-only tools for agent planning and mobile operation. This is a structured API layer, not a general command runner.

### Phase 8

- [Phase 8: Agent core and model routing](phase-8-agent-core-model-routing.md) — This phase connects the authenticated web endpoint to a rules-first agent core, a pluggable OpenAI-compatible model adapter, and the existing code-defined read-only tool registry. It is a…

### Phase 9

- [Phase 9: Operations task engine](phase-9-operations-task-engine.md) — All task endpoints require authentication. Submission is same-origin and JSON-only.

### Phase 10

- [Phase 10: permission policy foundation](phase-10-permission-policy-foundation.md) — This phase establishes a lightweight, confirm-first risk policy for a personal NAS assistant. The user has already completed the assistant's sign-in / official Skill authorization flow; do…

### Phase 11

- [Phase 11: Static Skill Manifest Review](phase-11-static-skill-manifest-review.md) — Static findings are advisory review signals, not proof that a Skill is safe or malicious. Imported content and its declared name/capabilities remain untrusted. The feature does not enable…

### Phase 12

- [Phase 12: One-time Approval Ledger](phase-12-one-time-approval-ledger.md) — This is a reusable ledger, not a UI or an execution endpoint. It does not authenticate callers, decide whether a human really approved, execute tools, or persist grants across process…

### Phase 13

- [Phase 13: Mobile Operations Workbench](phase-13-mobile-operations-workbench.md) — Cancellation never kills an in-flight operating-system operation and does not grant additional permissions. A running cancellation is cooperative: the active operation finishes, then the…

### Phase 14

- [Phase 14: Authentication and Resource-Boundary Hardening](phase-14-auth-security-hardening.md) — The service still recommends trusted-LAN-only use while HTTP is configured. A Secure cookie flag is applied only when TLS terminates directly at this server; deployments behind a reverse…

### Phase 15

- [Phase 15: Release Readiness Gates](phase-15-release-readiness-gates.md) — Create a deterministic pre-release gate that can run on Node.js 26.x without third-party dependencies. It verifies that the release workflow still tests the supported runtime line and…

### Phase 16

- [Phase 16: FPK Integration Smoke Tests](phase-16-integration-smoke-tests.md) — This phase does not deploy to a NAS, execute imported Skills, or enable arbitrary commands.

### Phase 17

- [Phase 17: HTTP Authentication Contract Tests](phase-17-http-auth-contract-tests.md) — Run the actual HTTP server as a child process against a temporary data directory and an ephemeral loopback port. Exercise first-run setup, rejection of state-changing requests without…

### Phase 18

- [Phase 18: FPK Artifact Integrity](phase-18-fpk-artifact-integrity.md) — The verifier only lists archive metadata; it does not extract or execute the package. CI continues to publish a checksum for the exact artifact. It is a structural gate, not a signature or…

### Phase 19

- [Phase 19: Model Adapter Contract Tests](phase-19-model-adapter-contract-tests.md) — Use a mocked fetch implementation to test the optional model adapter without network access or API credentials. Cover explicit opt-in and HTTPS endpoint validation, secret-safe status…

### Phase 20

- [Phase 20: Audit Trail and Operation Trace](phase-20-audit-trail.md) — Audit records are metadata, not a transcript. Health polling and the static UI are excluded to prevent high-volume noise. Route labels come from a fixed allowlist; dynamic IDs and query…

### Phase 21

- [Phase 21: Task Persistence and Crash Recovery](phase-21-task-persistence-recovery.md) — A missing state file means there is no prior history. Invalid JSON or an unsupported schema fails startup instead of silently deleting operational history. Persistence uses atomic rename to…

### Phase 22

- [Phase 22: Release Candidate Acceptance](phase-22-release-candidate-acceptance.md) — Make a release candidate reviewable as a single acceptance package after Phases 19–21. CI success proves repeatable software checks; it does not certify an installation on every fnOS…

### Phase 24

- [Phase 24: Release Hygiene and Smoke Checks](phase-24-release-hygiene-and-smoke-checks.md) — Keep release instructions, branch triggers, and automated safety gates aligned so a completed phase cannot silently disappear from the mainline or become hard to validate.

### Phase 25

- [Phase 25: Release Manifest and Build Provenance](phase-25-release-manifest-and-provenance.md) — Attach a machine-readable manifest to every CI-built FPK so a reviewer can verify the exact artifact checksum and identify the source commit and workflow run that produced it.

### Phase 26

- [Phase 26: Release Artifact Verification](phase-26-release-artifact-verification.md) — Provide a standalone, dependency-free verifier for a downloaded FPK, its sha256sum-compatible checksum file, and the Phase 25 JSON release manifest.

### Phase 27

- [Phase 27 — Build provenance attestation](phase-27-build-provenance-attestation.md) — Phase 112 enables CI builds of an unsigned x86 test FPK. Phase 114 adds a GitHub artifact attestation job for successful builds on main only:

### Phase 28

- [Phase 28 — Practical read-only file browser](phase-28-practical-file-browser.md) — Add a useful mobile-friendly file browser without enabling arbitrary file access or mutations. This is an initial practical NAS feature, not a full file manager.

### Phase 29

- [Phase 29 — Mobile fnOS Read-only Tool Usability](phase-29-mobile-fnos-tools.md) — Design and delivery record for this iteration.

### Phase 30

- [Phase 30 — fnOS CLI Path Traversal Guard](phase-30-trim-cli-path-traversal-guard.md) — This hardening narrows accepted input only. It adds no commands, permissions, or filesystem operations and does not replace verification against the official CLI on a test fnOS device.

### Phase 31

- [Phase 31 — Practical fnOS Photo Search and Capability Checks](phase-31-fnos-photo-tools.md) — Design and delivery record for this iteration.

### Phase 32

- [Phase 32 — Confirm-First Action Policy](phase-32-confirm-first-action-policy.md) — This is a personal fnOS NAS assistant, not a corporate permission workflow. The user completes sign-in / official Skill authorization once. Routine actions should remain convenient…

### Phase 33

- [Phase 33 — Practical routine file writes](phase-33-practical-file-write-tools.md) — This phase exposes three already-implemented file-manager operations through the Agent's server-controlled tool catalogue:

### Phase 34

- [Phase 34 — Explicit confirmation for destructive file actions](phase-34-confirmed-destructive-file-actions.md) — This phase wires the existing one-time approval ledger into a small action service and authenticated HTTP routes. It supports deleting one regular file or an empty directory, while the file…

### Phase 35

- [Phase 35 — Agent Text-File Creation](phase-35-agent-text-file-creation.md) — The tool is a normal write operation and does not require repeated confirmation. Its risk comes from the server-side registry, not the model. Deletion remains destructive and uses the…

### Phase 36

- [Phase 36 — Bounded Agent File Upload](phase-36-bounded-agent-file-upload.md) — Design and delivery record for this iteration.

### Phase 37

- [Phase 37 — Natural-Language Operations Coverage](phase-37-natural-language-operations.md) — Expand the rules-first mobile Agent so common read-only fnOS and file-management requests work without configuring a model API.

### Phase 38

- [Phase 38 — Core Integration and Fast Feedback](phase-38-core-integration-fast-feedback.md) — Design and delivery record for this iteration.

### Phase 39

- [Phase 39 — Official fnOS Skill Archive Compatibility](phase-39-official-skill-archive-compatibility.md) — The supplied official fnOS Skill ZIP is approximately 17.7 MB compressed and declares approximately 43.4 MB of uncompressed entries because it bundles CLI binaries for six…

### Phase 40

- [Phase 40 — Reviewed Official fnOS CLI Installation](phase-40-reviewed-cli-install.md) — Design and delivery record for this iteration.

### Phase 41

- [Phase 41 — Dynamic CLI Provider Integration Fix](phase-41-trim-cli-provider-fix.md) — The Phase 40 server passes binaryPathProvider to createTrimCliAdapter so an enabled, reviewed fnOS Skill can supply its managed CLI path. The adapter's options destructuring omitted that…

### Phase 42

- [Phase 42 — CLI connection health and guided verification](phase-42-cli-connection-health.md) — This phase does not implement browser OAuth, collect authorization codes, request passwords from the CLI, or persist tokens. The user must configure the official CLI profile through its…

### Phase 43

- [Phase 43 — Guided official CLI OAuth setup](phase-43-guided-oauth-setup.md) — Provide a practical first-login path for the official trim-cli integration without moving OAuth credentials or the one-time authorization code through the Agent web application.

### Phase 44

- [Phase 44 — Connection recovery and read-only CLI closure](phase-44-cli-health-and-readonly-closure.md) — The adapter now tracks the latest result from actual allowlisted CLI requests in process memory, without persisting profile contents, access tokens, refresh tokens, authorization codes, raw…

### Phase 45

- [Phase 45 — Model provider management](phase-45-model-provider-manager.md) — The mobile Agent UI can add, edit, enable/disable, test, select as default, and delete multiple OpenAI-compatible Chat Completions providers. Each provider stores a display name, full HTTPS…

### Phase 46

- [Phase 46 — Model provider reliability and quick setup](phase-46-model-reliability.md) — Failover is opt-in per provider: checking “备用模型” marks it eligible. A normal enabled provider that is not marked as a backup will never be used as an automatic fallback. Backups are tried…

### Phase 47

- [Phase 47 — Bounded conversation context](phase-47-conversation-context.md) — This phase adds practical multi-turn follow-up support to the mobile Agent without introducing a server-side transcript store.

### Phase 48

- [Phase 48 — Bounded task progress reporting](phase-48-task-progress.md) — This phase extends the existing task manager with a small progress contract for long-running operations.

### Phase 49

- [Phase 49 — Bounded batch file operations](phase-49-batch-file-operations.md) — The file manager now exposes operateBatch({ operations }) for grouped file actions. Batches accept 1–20 operations and execute sequentially, preserving a stable result order. A failure in…

### Phase 50

- [Phase 50 — Mobile Task Progress UI](phase-50-mobile-task-progress-ui.md) — The mobile workbench now renders task progress using the existing task API:

### Phase 51

- [Phase 51 — Authenticated Batch File Operations API](phase-51-batch-files-api.md) — Adds POST /api/files/operations/batch on top of the existing bounded file-manager batch contract.

### Phase 53

- [Phase 53 — Model catalog discovery](phase-53-model-catalog-discovery.md) — Allow the mobile model manager to discover model IDs from OpenAI-compatible provider catalogs instead of requiring users to guess model names.

### Phase 54

- [Phase 54 — Expanded model provider presets](phase-54-provider-presets-expansion.md) — Adds quick-start presets for:

### Phase 55

- [Phase 55 — Mobile Skill inventory search and filters](phase-55-skill-search-filters.md) — The UI is intended for mobile and desktop browsers. Automated Node.js 26 tests cover search matching, state filtering, and pagination; they do not constitute real-browser or fnOS NAS…

### Phase 56

- [Phase 56 — Local Ollama provider](phase-56-local-ollama-provider.md) — Adds a preset for Ollama's OpenAI-compatible Chat Completions endpoint on the same NAS host.

### Phase 57

- [Phase 57 — Mobile model catalog picker](phase-57-model-catalog-picker.md) — Replaces the browser prompt-based model selection with an inline, accessible picker in the model-provider card.

### Phase 58

- [Phase 58 — Filtered and paginated task history API](phase-58-task-history-filters.md) — Adds server-side status filtering and offset pagination to the authenticated GET /api/tasks endpoint.

### Phase 59

- [Phase 59 — Bulk Skill review transitions](phase-59-bulk-skill-review.md) — Adds authenticated POST /api/skills/transitions/batch for reviewing a selected group of Skill records in one request.

### Phase 60

- [Phase 60 — Mobile bulk Skill review](phase-60-bulk-skill-review-ui.md) — Adds selection checkboxes to Skill cards and a bulk target-state control.

### Phase 61

- [Phase 61 — Mobile task history controls](phase-61-task-history-mobile-ui.md) — Automated coverage is a UI contract test; no real browser or fnOS NAS is used.

### Phase 62

- [Phase 62 — Model adapter retry resilience](phase-62-model-adapter-error-resilience.md) — The OpenAI-compatible adapter now honors a provider's Retry-After response header when retrying retryable HTTP errors such as 429 and 5xx.

### Phase 63

- [Phase 63 — Skill archive review hardening](phase-63-skill-archive-review-hardening.md) — Static Skill manifest review now adds advisory findings for:

### Phase 64

- [Phase 64 — Clear terminal task history](phase-64-clear-terminal-task-history.md) — Adds an authenticated, same-origin POST /api/tasks/clear-history endpoint that removes only completed, failed and cancelled task records. Queued and running tasks are preserved and never…

### Phase 65

- [Phase 65 — Mobile audit history filters](phase-65-audit-history-mobile-ui.md) — Audit data remains bounded by the existing current/rotated log files. The UI renders audit entries as text, not HTML.

### Phase 66

- [Phase 66 — Task history cleanup control](phase-66-task-history-cleanup-ui.md) — Adds a mobile task-history action that asks for confirmation before clearing terminal records. The UI explicitly states that queued and running tasks are preserved and will not be…

### Phase 67

- [Phase 67 — Task result details](phase-67-task-result-details.md) — Completed task cards now provide an expandable result section for tool outputs, limited to the first 10 result items and 12,000 rendered characters. Results are assigned through…

### Phase 68

- [Phase 68 — Gemini and Groq presets](phase-68-gemini-groq-presets.md) — Adds quick-start presets for Google Gemini's OpenAI-compatible Chat Completions API and Groq's OpenAI-compatible endpoint.

### Phase 69

- [Phase 69 — Bounded retained task results](phase-69-bounded-task-results.md) — The task manager now projects completed results into a bounded, JSON-safe structure before retaining them in memory or returning them through task APIs.

### Phase 76

- [Phase 76 — Model action rate limiting](phase-76-model-action-rate-limit.md) — The authenticated model catalog discovery and connection-test actions share a per-session fixed-window limit of 10 attempts per minute. Requests over the limit receive HTTP 429 with…

### Phase 77

- [Phase 77 — Mobile upload progress](phase-77-mobile-upload-progress.md) — The mobile file manager now uses an upload-progress event to show percentage completion for file uploads.

### Phase 78

- [Phase 78 — Cancel mobile uploads](phase-78-cancel-file-upload.md) — Adds a cancel button while an upload is in progress. The browser aborts the active XMLHttpRequest and refreshes the current directory afterward because an abort near completion cannot…

### Phase 79

- [Phase 79 — Mobile file search and sorting](phase-79-mobile-file-search-sort.md) — The mobile file browser now filters the currently listed directory by case-insensitive filename, restricts the view to files or folders, and sorts the visible entries by name, size, or…

### Phase 80

- [Phase 80 — Cooperative running-task cancellation](phase-80-cooperative-task-cancel.md) — The mobile task history can now request cancellation for a running Agent task, not just remove a queued task.
- [Phase 80 — Skill archive upload progress and cancellation](phase-80-skill-archive-upload-progress.md) — The mobile Skill ZIP import form now shows browser upload progress and provides a cancel button while the upload request is active.

### Phase 81

- [Phase 81 — Sequential multi-Skill ZIP import](phase-81-multi-skill-upload.md) — The mobile Skill manager accepts multiple ZIP files and imports them sequentially through the existing quarantine endpoint.

### Phase 82

- [Phase 82 — Mobile file navigation breadcrumbs](phase-82-file-breadcrumbs.md) — The file browser displays a breadcrumb trail for the current directory. Parent segments are clickable and the current segment is marked as the current location.
- [Phase 82 — ZIP local-record overlap rejection](phase-82-zip-overlap-rejection.md) — The Skill ZIP inspector now rejects archives whose central-directory entries point to overlapping local file records or data ranges. This blocks ambiguous layouts where one entry is…

### Phase 83

- [Phase 83 — Sequential mobile multi-file upload](phase-83-mobile-multi-file-upload.md) — The mobile file browser can select multiple files and upload them sequentially to the current directory.

### Phase 84

- [Phase 84 — File browser pagination](phase-84-file-browser-pagination.md) — The file browser API now accepts a bounded offset in addition to the existing bounded page size. The mobile UI loads 100 entries at a time and shows total directory count plus previous/next…

### Phase 85

- [Phase 85 — File transfer HTTP integration](phase-85-file-transfer-http-integration.md) — Adds end-to-end coverage for authenticated file upload, bounded text preview, and download using a temporary configured storage root.

### Phase 86

- [Phase 86 — Skill archive import HTTP integration](phase-86-skill-import-http-integration.md) — Exercises the real HTTP route for quarantined Skill ZIP import in an isolated temporary data directory.

### Phase 91

- [Phase 91 — Bounded batch model connection testing](phase-91-model-batch-test.md) — Adds a mobile-friendly batch action to test configured model providers without firing an unbounded burst of requests.

### Phase 92

- [Phase 92 — Persist model connection-test latency](phase-92-model-test-latency.md) — The model provider store now persists the elapsed time and HTTP status code from the latest connection test alongside its existing safe summary.

### Phase 93

- [Phase 93 — Model connection diagnostics in the UI](phase-93-model-test-diagnostics-ui.md) — Model provider cards now show the latest connection-test duration and HTTP status code when available. The bounded batch tester also includes each provider's elapsed time in its result…

### Phase 94

- [Phase 94 — Model catalog HTTP integration](phase-94-model-catalog-http.md) — Exercises authenticated model catalog discovery against a local OpenAI-compatible mock server.

### Phase 95

- [Phase 95 — Searchable model catalog picker](phase-95-model-catalog-search.md) — Improves the mobile model-provider catalog picker for providers that return many model IDs.

### Phase 96

- [Phase 96 — Task history search](phase-96-task-history-search.md) — Adds keyword search to the existing authenticated task-history query and mobile UI.

### Phase 97

- [Phase 97 — GitHub Skill archive import](phase-97-github-skill-archive-import.md) — Adds a mobile-friendly option to import a Skill from a GitHub branch or tag ZIP URL without manually downloading and uploading the archive.

### Phase 98

- [Phase 98 — Direct natural-language fnOS queries](phase-98-fnos-query-intents.md) — Extends the rules-first Agent path to cover existing official fnOS CLI read-only operations that were already registered but lacked direct natural-language aliases.

### Phase 99

- [Phase 99 — GitHub repository URL shortcut](phase-99-github-repo-shortcut.md) — Improves remote Skill import convenience: users may paste the repository root URL as well as a branch/tag archive URL.

### Phase 100

- [Phase 100 — Skill source provenance](phase-100-skill-source-provenance.md) — Records the exact Git reference used during direct GitHub ZIP import so it is easier to distinguish Skills imported from different branches or release tags.

### Phase 101

- [Phase 101 — Expanded official fnOS read-only operations](phase-101-official-readonly-tools.md) — Expands the Agent's fixed allowlist from the documented official fnOS Skill command reference. These commands are read-only and use hard-coded argv arrays; user text and model output cannot…

### Phase 102

- [Phase 102 — Immutable GitHub Skill commit pinning](phase-102-pin-skill-commit.md) — Resolves each GitHub branch or tag to a commit SHA before downloading the archive. This makes the downloaded ZIP immutable for the duration of import and gives reviewers a stable source…

### Phase 103

- [Phase 103 — Bounded Skill source static review](phase-103-skill-source-static-review.md) — Extends the existing manifest-only review with an advisory scan of selected source and script files inside a validated Skill ZIP.

### Phase 104

- [Phase 104 — Batch GitHub Skill import](phase-104-batch-github-skill-import.md) — Adds a batch path to the existing pinned-commit GitHub ZIP importer.

### Phase 105

- [Phase 105 — Embedded credential and key scanning for Skills](phase-105-skill-secret-scanning.md) — Extends the bounded Phase 103 source scan to flag credential-like material in Skills before approval.

### Phase 106

- [Phase 106 — Honest API semantics for running-task cancellation](phase-106-running-task-cancel-api.md) — Aligns the task cancellation endpoint with the task manager's existing cooperative cancellation support.

### Phase 107

- [Phase 107 — Quarantined Skill source preview](phase-107-skill-quarantine-source-preview.md) — Adds a read-only file browser for imported Skill archives so a reviewer can inspect the actual source behind static-review findings.

### Phase 108

- [Phase 108 — File SHA-256 checksum](phase-108-file-sha256-checksum.md) — Adds an authenticated, read-only checksum operation to the mobile file browser.

### Phase 110

- [Phase 110 — Approval Queue Revocation Consistency](phase-110-approval-queue-consistency.md) — The approval ledger revokes grants by task ID. The action approval service previously removed only one queue item when denying an approval or pruning an expired grant, while revoking every…

### Phase 111

- [Phase 111 — Task Snapshot Persistence Retry](phase-111-task-persistence-retry.md) — The task manager serialized snapshot writes through a promise chain. If a filesystem error rejected one write, later writes chained directly from that rejected promise and never invoked the…

### Phase 112

- [Phase 112 — FPK CI Build and Artifact Verification](phase-112-fpk-ci-build-and-artifact-verification.md) — Resume automated FPK validation after the core application stabilized, without treating a successful CI job as certification of a real fnOS installation.

### Phase 113

- [Phase 113 — FPK Lifecycle Process Identity](phase-113-fpk-process-identity.md) — The native FPK launcher previously trusted only the PID stored in TRIM_PKGVAR/agent.pid and whether kill -0 succeeded. If the service exited and the OS later reused that PID, status could…

### Phase 114

- [Phase 114 — FPK Build Provenance Attestation](phase-114-build-provenance-attestation.md) — Attach verifiable GitHub build provenance to the exact FPK produced by a successful main-branch build, without exposing attestation permissions to pull-request jobs or routine build steps.

### Phase 115

- [Phase 115 — Immutable GitHub Actions References](phase-115-github-actions-pinning.md) — Prevent a moved major-version or release tag from silently changing the third-party code executed by the FPK build pipeline.

### Phase 116

- [Phase 116 — Post-signing Attestation Verification](phase-116-attestation-verification.md) — The attestation action must not be treated as the final gate by itself. After signing the exact FPK, the same isolated main-only job performs a cryptographic verification and enforces the…

### Phase 117

- [Phase 117 — FPK Lifecycle Smoke Verification](phase-117-fpk-lifecycle-smoke.md) — Validate the native lifecycle script contract on a Linux CI runner using an isolated fake app install directory and a temporary data directory. These tests catch regressions in the start…

### Phase 118

- [Phase 118 — File Read Descriptor Confinement](phase-118-file-read-descriptor-confinement.md) — The file browser validated a path with realpath and lstat, then reopened the path by name for preview, checksum, or download. A path entry could be replaced after validation but before the…

### Phase 119

- [Phase 119 — Expired Session Cleanup Error Handling](phase-119-expired-session-cleanup.md) — When a request arrived with an expired session, the request path removed that session and triggered a persistence snapshot without awaiting or attaching a rejection handler. If the…

### Phase 120

- [Phase 120 — File Browser Directory Descriptor Confinement](phase-120-file-browser-directory-descriptor-confinement.md) — The file browser validated a directory path with realpath/lstat and then called readdir or inspected children via the pathname. If that directory or one of its path components was replaced…

### Phase 121

- [Phase 121 — Recoverable Session Persistence](phase-121-session-persistence-retry.md) — Session snapshots were serialized by chaining each write from the previous promise. A single filesystem failure left that promise rejected, so subsequent login/logout/expiry writes never…

### Phase 122

- [Phase 122 — File Mutation Directory Descriptor Confinement](phase-122-file-write-directory-descriptor-confinement.md) — Upload, text creation, folder creation, rename/move, and deletion validated a directory path before later operating on the pathname. A path change between those steps could redirect a…

### Phase 123

- [Phase 123 — Bundled Runtime FPK Lifecycle Smoke](phase-123-fpk-bundled-runtime-smoke.md) — Run the packaged Node.js runtime and actual application entry from the same temporary staging tree that fnpack will package. Static syntax checks and copying a runtime binary are not enough…

### Phase 124

- [Phase 124 — Recoverable Skill Inventory Persistence](phase-124-skill-store-persistence-retry.md) — The Skill inventory chained writes using the previous write promise. After one filesystem failure, the queue stayed rejected and later registrations, state transitions, and removals could…

### Phase 125

- [Phase 125 — Skill Quarantine Directory Descriptor Confinement](phase-125-skill-quarantine-directory-descriptor-confinement.md) — The ZIP quarantine writer checked the quarantine directory with lstat, then used mutable pathnames for the temporary archive, final archive, chmod, and read-back verification. A directory…

### Phase 126

- [Phase 126 — Execution policy: global read-only mode and kill switch](phase-126-execution-policy.md) — apps/fnos-nas-agent/app/execution-policy.mjs introduces a single, server-side decision point for "may this tool call run right now?". It closes the gap described in docs/security.md:72:

### Phase 127

- [Phase 127 — Destructive capability tokens and approval binding](phase-127-destructive-capability.md) — Until Phase 127 the "confirmation" for a destructive file operation was a boolean in the request body:

### Phase 128

- [Phase 128 — Audit log hardening](phase-128-audit-log-hardening.md) — Phase 128 removes the failure mode where a single unauthenticated request could terminate the process: audit recording must never throw synchronously, unknown routes are normalized instead…

### Phase 129

- [Phase 129 — State file recovery and durable writes](phase-129-state-file-recovery.md) — Phase 129 makes a corrupted state file a recoverable condition instead of a startup failure: task and skill inventories are backed up and the service continues with an empty state, and…

### Phase 130

- [Phase 130 — Release Consistency](phase-130-release-consistency.md) — Close the gaps found by a documentation-versus-code audit of the repository: a missing license, a version number that existed in more than one place, CI trigger rules that no longer matched…

### Phase 131

- [Phase 131 — Server hardening: setup code, policy surface and session-bound approvals](phase-131-server-hardening.md) — Phase 126 and 127 introduced the execution policy and the destructive capability token. Phase 131 wires that policy into every HTTP entry point, closes the first-run setup race described in docs/security.md, and makes the running service report the state it is in.

### Phase 132

- [Phase 132 — Real NAS staging acceptance](phase-132-nas-staging-acceptance.md) — The audit that started this round listed "no real NAS staging acceptance" as an open risk. This phase records the acceptance run that closed it.

### Phase 133

- [Phase 133 — Model fallback, scan bounds and one decision point](phase-133-model-fallback-and-scan-bounds.md) — Phase 126 moved the execution decision into a single policy module. Phase 133 removes the remaining places where a second, weaker decision was made, and repairs the two availability bugs the audit found behind it.

### Phase 134

- [Phase 134 — Overview service](phase-134-overview-service.md) — The overview page used to need six parallel API calls. Phase 134 adds one aggregation service and one endpoint that returns every headline number in a single, secret-free snapshot.

### Phase 135

- [Phase 135 — Mobile first user interface](phase-135-mobile-first-user-interface.md) — The console was a desktop page squeezed onto a phone. Phase 135 rebuilds it mobile first and splits the single file into a static shell, one stylesheet and two scripts.

### Phase 136

- [Phase 136 — Skill trust hardening](phase-136-skill-trust-hardening.md) — The Skill domain let the client declare its own static review verdict and point the record at a quarantine file of its choosing. Phase 136 moves every such decision back to the server, makes Skill names unique regardless of letter case, requires a server-side review before approval and before the official CLI is installed, reports unscanned archive entries as findings, charges the batch download budget for failed downloads, keeps local failures out of the remote error path, and normalizes a `.git` suffix before any GitHub request is built.

### Phase 137

- [Phase 137 — Task and approval lifecycle](phase-137-task-approval-lifecycle.md) — A destructive action used to be a one-off: the agent asked for approval, the operator confirmed it, and the task record quietly claimed success. Phase 137 makes the approval and the task one lifecycle, keeps awaiting-approval out of the terminal states, and scopes every task lookup to the session that owns it.

### Phase 138

- [Phase 138 — File domain hardening](phase-138-file-domain-hardening.md) — The file tools worked, but their edge cases lied: the agent could not page through a directory, a symlink reported itself as an out-of-root path, a failed upload reported the wrong status code, and one oversized folder could abort a whole search. Phase 138 gives the file list an offset, tells symlinks and out-of-root paths apart, publishes uploads atomically even without hard link support, decodes Base64 with the right status code, and reports directory counts from a single source of truth.

### Phase 139

- [Phase 139 — Reverse proxy deployment](phase-139-reverse-proxy-deployment.md) — The agent never documented which environment variables it actually reads, and it rejected every write request that arrived through a TLS-terminating reverse proxy. Phase 139 rewrites the environment template from the real defaults and documents how to put the agent behind nginx or the fnOS portal without breaking the origin check or the session cookie.
### Phase 140

### Phase 141

### Phase 142

- [Phase 142 — Official CLI Manifest Paths](phase-142-official-cli-manifest-paths.md) — the binary path declared by the official package manifest is resolved against the package folder, so the official CLI can be installed.

### Phase 143

- [Phase 143 — Official CLI Login Guidance](phase-143-cli-login-required.md) — the official CLI answers a profile that was never logged in with a plain "run login first"; the console used to report it as an unexpected 502, and now it answers 401 with the exact login step.

- [Phase 141 — Official Skill Identity](phase-141-official-skill-identity.md) — the official fnOS package identity follows the server side review instead of the name the operator typed.

- [Phase 140 — Model provider resilience](phase-140-model-provider-resilience.md) — A model provider that could not answer was treated as the end of the line: the configured fallback was never tried, a single corrupted record disabled every provider, and a request that had already been cancelled still spent minutes on the wire. Phase 140 promotes an enabled fallback to the primary slot, keeps one broken record from taking the whole catalog down, distinguishes a cancelled request from a failed one, and reports HTTP attempts and wall-clock latency next to the existing counters.

### Phase 144

- [Phase 144 — Skill package format](phase-144-skill-package-format.md) — A Skill archive was an opaque ZIP: the agent could list its entries, but it could not tell a valid package from a broken one. Phase 144 parses the canonical package layout in memory — one SKILL.md, an optional metadata.json, and the references, scripts and tests folders — and reports every deviation as a named finding, without extracting or executing anything.

### Phase 145

- [Phase 145 — Dangerous command rule pack](phase-145-dangerous-command-rules.md) — The rules that decide whether a command is dangerous were hard coded in two modules, so shell, PowerShell, Python and Node.js constructs were judged inconsistently. Phase 145 moves them into one dependency free rule pack that is shared by the manifest review, the source review and the command scanner.

### Phase 146

- [Phase 146 — Tool call observability](phase-146-tool-trace.md) — The audit log recorded the HTTP request that led to a tool call and nothing about the call itself, so a failed task could not be told apart from a model timeout, a denied destructive action and a broken path. Phase 146 traces every tool invocation with its identity, timing, outcome and a fixed error classification, and it adds a one line per event JSON logger that drops secret looking fields.

- [Phase 146 — Task event stream](phase-146-task-events.md) — The conversation window had to poll the task queue to learn what the agent was doing. Phase 146 gives every task an event stream with progress, tool, approval, done and error events, and it keeps the terminal event unique so a failed task ends with exactly one event.

### Phase 147

- [Phase 147 — Registrable tool registry](phase-147-tool-registry.md) — The tool catalogue was a hard coded list, so a Skill or an MCP server could not publish a tool into it and the origin of a tool was invisible. Phase 147 turns the catalogue into a registry of tagged sources, and it keeps the execution policy of the product in force for every foreign tool.

### Phase 148

- [Phase 148 — MCP client](phase-148-mcp-client.md) — The agent could not speak the protocol that Marvis uses to reach its tools. Phase 148 adds a dependency free JSON-RPC client over the stdio transport, a configuration file for the servers, and the rules that keep a foreign server from weakening the safety contract of the agent.

### Phase 149

- [Phase 149 — Marvis style conversation window](phase-149-chat-window.md) — The agent answered in a form panel: one result block, a poll, and no trace of how the answer was produced. Phase 149 rebuilds the chat surface as a conversation — bubbles, a multi line composer, tool cards, an inline approval, a stop button, and a streamed progress — with the same security rules as before.

### Phase 150

- [Phase 150 — Model chat adapter](phase-150-model-chat-adapter.md) — The repository could talk to an OpenAI compatible provider, but only in the plan shape. Phase 150 adds the transport of the chat channel: it streams the answer token by token, it bounds the conversation and the answer, and it speaks a fixed error vocabulary.

### Phase 151

- [Phase 151 — Direct chat channel over HTTP](phase-151-direct-chat-http.md) — A plain conversation had no route: the only channel answered with a plan. Phase 151 adds the streaming chat route with the same origin, session, rate limit and endpoint whitelist rules as the rest of the product, and it keeps the chat turn apart from the tool contract of the planner.

- [Phase 151 — Dual-mode chat window](phase-151-chat-direct-mode.md) — The conversation window could only talk to the task pipeline, so a plain question still created a NAS task and answered with tool cards. This phase makes the window dual-mode: the operator switches between the task mode and the direct chat mode, and the direct mode streams a plain text answer from the chat channel.

### Phase 153

- [Phase 153 — MCP tool bridge](phase-153-mcp-tool-bridge.md) — The tool registry of Phase 147 and the MCP client of Phase 148 did not meet: a foreign server could publish any name it wanted, and a tool from outside had no place where its risk was decided. This phase bridges the two and keeps the safety rules while a foreign tool runs.

### Phase 154

- [Phase 154 — Model settings UI](phase-154-model-settings-ui.md) — The provider manager grew into a real settings surface: the API key is shown as a fingerprint instead of a clear value, the password never comes back in clear text while it is edited, a failed save names the field that caused it, and adding a provider and entering its credentials are two separate steps.

### Phase 155

- [Phase 155 — Tool call observer](phase-155-tool-call-observer.md) — The tracer of Phase 146 existed, but nothing called it: the built-in catalogue, the agent plan and the external MCP tools all ran without a trace entry. Phase 155 wires the observer into those three call sites, so a real run leaves the same evidence the tests did.

### Phase 156

- [Phase 156 — Marvis migration integration](phase-156-marvis-migration-integration.md) — The migration ran phase by phase and every phase kept its own document, so nothing in the repository said which Marvis capability is now part of it, where it lives and which rule keeps it safe. This phase writes that map down, together with the naming and risk rules of the MCP bridge, the red lines that survived the migration and the limits that are still open. It adds no runtime code.

### Phase 157

- [Phase 157 — UI integration verification](phase-157-ui-integration.md) — The model settings module of Phase 154 and the conversation window of Phase 149/151 were written, but nothing proved that the page actually used them. This phase verifies the real page against the real module: the wizard state classes match the stylesheet, the page listens for the ready event of the module so the first screen is never empty, the provider card carries the model settings classes, the invalid state sits on the field container, and the submit handler guards the form like the input handler does. It also found five real defects, fixed them, and turned every placeholder into a real assertion.

### Phase 158

- [Phase 158 — Windows absolute path guard](phase-158-windows-absolute-path.md) — The installer decided that an absolute path starts with a slash, which is true on POSIX and false on Windows, so the service refused to start with a data directory and 18 unrelated HTTP tests failed on a Windows machine. This phase replaces the check with the platform independent isAbsolute() and keeps a regression test for it.

### Phase 160

- [Phase 160 — Security audit report](phase-160-security-audit.md) — The audit log had a writer but no reader, so the recorded evidence could never be shown to the operator. This phase adds a read-only inspection that turns the log entries into a report of six security sections, a tool permission table and an audit summary, without changing anything on the NAS.

### Phase 161

- [Phase 161 — System snapshot](phase-161-system-snapshot.md) — The agent could answer questions but could not show the real state of the machine. This phase reads the official trim-cli sources and produces a six section snapshot; a section that could not be measured stays "unknown" instead of being reported as healthy.

### Phase 162

- [Phase 162 — Diagnostics](phase-162-diagnostics.md) — A symptom without evidence produced guesswork. This phase ranks the likely causes from the evidence, grades the confidence, and filters every suggested next step through a safety rule that rejects destructive actions.

### Phase 163

- [Phase 163 — Duplicate detector](phase-163-duplicate-detector.md) — The same request could be issued twice and the agent would run it twice. This phase compares the new request with the recent ones and reports the duplicates before anything is executed.

### Phase 164

- [Phase 164 — MCP server](phase-164-mcp-server.md) — The agent could call an external MCP server but no external client could call the agent. This phase publishes the read-only tool catalogue over a stdio JSON-RPC 2.0 entry point, with the same tool contract and the same risk rules as the HTTP side.

### Phase 165

- [Phase 165 — Model usage](phase-165-model-usage.md) — The agent used the model but did not know what it spent. This phase counts the requests, the tokens and the latency per model, keeps no prompt text, and reports an unpriced model as unpriced instead of guessing a price.

### Phase 166

- [Phase 166 — Agent insights](phase-166-agent-insights.md) — The observation modules of Phase 160–165 existed but had no common exit. This phase exposes the system snapshot, the security inspection, the model usage and the diagnostic report over authenticated read-only routes, adds the MCP stdio entry point, and proves the whole chain with a test that starts a real server.

### Phase 167

- [Phase 167 — Diagnostic evidence](phase-167-diagnostic-evidence.md) — The diagnosis engine ranked causes from evidence that nobody collected. This phase gathers the evidence from the audit log, the tool trace, the health checks and the system snapshot, reads only whitelisted fields, and caps every source and the total.

### Phase 168

- [Phase 168 — Workflow engine](phase-168-workflow-engine.md) — A health check plan was the only seed of automation. This phase adds a dependency graph, a cycle check, a per-workflow lock, an approval step that never approves itself, and a notification that carries no arguments.

### Phase 169

- [Phase 169 — Runbook store](phase-169-runbook-store.md) — The repository held documents but no reusable procedure. This phase adds a runbook store with stable search, a redacted write path and an atomic persistence, and refuses to overwrite an entry.

### Phase 170

- [Phase 170 — Observation routes](phase-170-observation-routes.md) — The evidence, workflow and runbook modules of Phase 167–169 existed but had no exit. This phase wires them into authenticated read-only routes, ships two read-only workflow plans, and proves the chain with a real HTTP test.

### Phase 171
- [Phase 171 — Verified write pipeline](phase-171-verified-write.md) — The agent could only read or warn. This phase registers a write action, binds it to a target and a one-time approval, runs the steps in order and keeps a verifiable record of what happened.

### Phase 172
- [Phase 172 — Network policy](phase-172-network-policy.md) — A fetch would have meant an open door to the internet. This phase decides per URL whether a request is allowed, with a closed default and an explicit allow list.

### Phase 173
- [Phase 173 — Diagnosis history](phase-173-diagnosis-history.md) — A diagnosis was lost as soon as it was shown. This phase keeps the history, groups it by conclusion and can absorb a human correction.

### Phase 174
- [Phase 174 — Observation panel](phase-174-observation-panel.md) — The workflow plans, the runbooks and the diagnostic evidence existed on the server but not on the screen. This phase shows all three on the overview page, in parallel and read-only.

### Phase 175
- [Phase 175 — Controlled web fetch](phase-175-web-fetch.md) — The policy could decide, but nothing could fetch. This phase fetches a page under the policy, re-checks every redirect hop and returns cleaned evidence instead of the raw page.

### Phase 176
- [Phase 176 — Diagnosis and policy routes](phase-176-diagnosis-and-policy-routes.md) — The modules of Phase 171–175 had no exit. This phase exposes the diagnosis history, the write action registry, the network policy and the controlled fetch over authenticated routes and proves the chain with a real HTTP test.

### Phase 177
- [Phase 177 — Knowledge base](phase-177-knowledge-base.md) — Facts learned from the NAS were stored but never ranked, dated or cited. This phase adds a source-aware knowledge base whose entries carry provenance, freshness and open conflicts instead of a single "known fact".

### Phase 178
- [Phase 178 — Network diagnostics](phase-178-network-diagnostics.md) — "The network is slow" was not answerable. This phase turns link state, latency samples and DNS results into a structured verdict with explicit gaps instead of a guess.

### Phase 179
- [Phase 179 — Knowledge panel and notifications](phase-179-knowledge-and-notifications.md) — The knowledge base and the event streams had no screen. This phase renders cited knowledge, the read-only application inventory and a notification centre, and hides credentials before display.

### Phase 180
- [Phase 180 — Docker advisor](phase-180-docker-advisor.md) — Container advice was generic. This phase reads the collected container data and produces per-container findings with a reason, a severity and a next step, without touching Docker.
### Phase 184
- [Phase 184 — Duplicate file scan route](phase-184-files-duplicates.md) — The duplicate detector existed without a route. This phase exposes a bounded, rate-limited scan of the current directory and reports size groups, hashes and reclaimable space without touching any file.

### Phase 185
- [Phase 185 — Marvis runtime capability map](phase-185-marvis-runtime-capability-map.md) — Running the shipped Marvis on the NAS made its runtime capabilities observable. This phase maps the live JSBridge surface, records what was learned, and states which parts are worth porting and which are deliberately not.

### Phase 186
- [Phase 186 — Device capability check](phase-186-device-capability.md) — "Can this box run it?" was unanswerable. This phase judges five dimensions one by one, keeps unknown as unknown instead of guessing, and ships both the API and the two-button UI entry.

### Phase 187
- [Phase 187 — Skill package review](phase-187-skill-package-review.md) — The Phase 144 package parser was never imported: an imported Skill was reviewed for risky source but never for its own structure. This phase makes the structure a stored, comparable verdict and shows it on the Skill card, while a hand-edited verdict can never claim the server reviewed it.

### Phase 188
- [Phase 188 — Capacity trend forecast](phase-188-capacity-forecast.md) — Disk usage had no history and therefore no trend. This phase adds a pure planner that cleans samples, derives a growth rate with an explicit confidence, and only predicts a fill date when the evidence supports one.

### Phase 189
- [Phase 189 — Batch rename planner](phase-189-batch-rename.md) — Renaming many files one dialog at a time is slow and error-prone. This phase plans a batch as a pure function (four modes, four conflict classes) and executes it through an injected rename with an ordered rollback, so a failure halfway never leaves a half-renamed directory.

### Phase 190
- [Phase 190 — Service status parsing](phase-190-service-status.md) — "Is the service running?" was answered by nothing. This phase validates unit names, parses `systemctl show` output, and maps it to running/stopped/failed/unknown without ever guessing a verdict; a missing collector reports unknown instead of healthy.

### Phase 191
- [Phase 191 — Runtime wiring](phase-191-runtime-wiring.md) — The Phase 188–190 layers had no outlet: no route, no collector, no button. This phase adds the fixed-argv systemctl collector, the hourly disk-usage history, three guarded routes, and two UI cards (services/trend, plan-then-apply batch rename).

### Phase 192
- [Phase 192 — SMART health](phase-192-smart-health.md) — Pure parsing and judgement for `smartctl -H -A`: identify support state, read the ATA attribute table, and turn reallocated/pending/offline sectors, CRC errors and temperature into ok/warning/failed/unknown without ever inventing a healthy verdict.

### Phase 193
- [Phase 193 — Thermal status](phase-193-thermal-status.md) — Turns raw thermal-zone readings into a bounded classification: strict milli-Celsius parsing, per-source de-duplication, and a summariser that reports unknown (never 0 °C) when nothing credible was measured.

### Phase 194
- [Phase 194 — System events](phase-194-system-events.md) — Parses kmsg, journalctl short and `LEVEL:` lines into normalised events, groups repeats by a value-normalised message, and grades the log as ok/warning/critical/unknown while keeping dropped-line accounting exact.

### Phase 195
- [Phase 195 — Update check](phase-195-update-check.md) — Strict SemVer parsing and comparison with no network access: an unparsable side yields unknown rather than "up to date", downgrades are never offered, and the caller supplies the version to compare against.

### Phase 196
- [Phase 196 — Collectors](phase-196-collectors.md) — The read-only side of temperature and log events: fixed `/sys/class/thermal` zones and a 64 KiB tail of three whitelisted log files, both injectable for tests, both reporting what they could not read.

### Phase 197
- [Phase 197 — Device diagnosis](phase-197-device-diagnosis.md) — Wires the four pure layers to HTTP and the UI: four guarded GET routes plus a default-off smartctl collector, with every unmeasurable case reported as unknown instead of healthy.

### Phase 198
- [Phase 198 — Certificate check](phase-198-certificate-check.md) — Judges a certificate record the caller supplies: strict date parsing, wildcard-aware hostname matching, and ok/expiring/expired/invalid/unknown verdicts where a missing record or clock is unknown rather than healthy.

### Phase 199
- [Phase 199 — Idempotency](phase-199-idempotency.md) — A zero-dependency decision store for "the same request twice": execute/replay/in-progress/conflict/reject, request fingerprints from stable serialisation, TTL and LRU eviction, and a permanent in-progress record treated as a lease the caller must close.

### Phase 201
- [Phase 201 — Deployment precheck](phase-201-deployment-precheck.md) — Validates a structured deployment plan before anything runs: port mappings and conflicts, volume modes, root-user and privileged flags, secret-looking environment keys (names only), and a blocked/needs-review/ok/unknown verdict that never guesses.

### Phase 202
- [Phase 202 — Deploy, certificate and idempotency wiring](phase-202-deploy-cert-wiring.md) — Gives the three pure layers an outlet: two guarded POST routes that only judge what the caller supplied, optional `x-idempotency-key` replay/conflict handling, and audit route names.

### Phase 203
- [Phase 203 - 系统只读工具定义模块](phase-203-system-tools.md) — 把服务状态、SMART、温度、系统事件、快照、能力体检与容量预测包装成七个只读工具定义，让工具面板和 MCP 桥接自动看见它们。

### Phase 204
- [Phase 204 — Docker 实时资源采样的解析与判定层](phase-204-docker-stats.md) — 解析 `docker stats --no-stream` 的列式输出，给出用量/瓶颈判定与 `unknown` 语义，解析失败不留半截数据。

### Phase 205
- [Phase 205 — 网络采样的解析 / 增量 / 打包层](phase-205-network-collectors.md) — 解析 `/proc/net/dev` 计算增量吞吐；取不到样本时明确回 `unknown`，而不是把缺失当成零流量。

### Phase 206
- [Phase 206 — 工作流的事件触发判定层](phase-206-workflow-triggers.md) — 按阈值/事件/定时规则判定该触发哪些工作流，只产触发结果、绝不自行执行，非法规则进 `notes`。

### Phase 207
- [Phase 207 — 日志证据化层（D02 日志关联 / S13 系统事件）](phase-207-log-evidence.md) — 把日志尾部压成可引用的证据：只保留类别、级别、计数与脱敏摘要，原始行不出后端。

### Phase 208
- [Phase 208 - 设备与用户偏好档案](phase-208-device-profile.md) — 记录机主自述的硬件与偏好；凭据字段入库前丢弃，序列号只留后 4 位，写操作串行化并带新鲜度判定。

### Phase 209
- [Phase 209：技能组合（纯函数层）](phase-209-skill-composition.md) — 技能组合的归一化、七类校验、拓扑排序与运行计划；权限只升不降，被条件跳过的破坏性步骤也会抬高整体权限。

### Phase 210
- [Phase 210 — 把 203–209 接到 HTTP 上，并修好审计白名单](phase-210-wiring.md) — 给七个纯函数层补上 HTTP 与工具注册表出口，并把审计白名单从 44 个名字补到 97 个、加一条静态防回退用例。

### Phase 211
- [Phase 211：把「只在服务端存在」的能力真正摆到界面上](phase-211-ui-gap-coverage.md) — 审查出 19 条无界面入口的路由，接上 24 条入口（新增「诊断与运维」整页），保留 4 条有意 API-only，并用 7 例测试锁死。
- [Phase 212：文件页的批量选择与批量操作](phase-212-file-batch.md) — 目录列表多选（上限 20，与服务端一致），批量重命名（前缀+序号）与批量移动，结果逐项展示；批量删除不开放。
- [Phase 213：知识库的两步写入](phase-213-knowledge-write.md) — 独立模块 knowledge-write.js 做「预览 → 提交」，改表单即作废预览；顺手修掉来源筛选与服务端枚举不一致的真 bug，10 例测试。
- [Phase 214：知识条目的核验、标记过期与归档](phase-214-knowledge-entry-actions.md) — 条目上三个维护动作沿用两步写入（确认条 → previewId → commit），新增 `POST /api/knowledge/cancel` 丢弃未提交的预览，9 例测试。
- [Phase 215：只读步骤的失败重试](phase-215-retry-policy.md) — 只重试只读工具上的瞬时失败（超时/连接类/429/5xx），上限 3 次、指数退避；工作流路由接入并把重试记录放进响应，运维页可一键试运行内置工作流，14 例测试。
- [Phase 216：知识库的「显示已归档」开关](phase-216-knowledge-archived-view.md) — 列表页补上 `archived=1` 开关与「（含已归档）」状态；顺带修掉视图模型丢 `archived` 标记、归档条目被画出维护按钮的缺陷，4 例测试。
- [Phase 217：备份前检查](phase-217-backup-precheck.md) — 七项只读体检（空间、只读挂载、容量趋势、服务、SMART、诊断）拼成一句「现在能不能安心备份」；`GET /api/backup/precheck` + 运维页卡片，14 例纯函数用例与 1 例 401 边界。
- [Phase 218：模型 Endpoint 支持只填 base 地址](phase-218-model-endpoint-base.md) — `/v1`、根地址这类 base 直接可保存，服务端按规则补全 `/chat/completions`；`/v1/responses` 之类仍拒绝，新增两组用例覆盖补全与拒绝两侧。

## This index

- [Documentation index](README.md) — Complete list of documents in this directory, with a one-line summary for each.

# Marvis capability matrix

Every numbered item of the product checklist in
[marvis-feature-checklist.md](marvis-feature-checklist.md) with its state in
this repository, the phase that implements it and the gap that is still open.

The checklist is a **product plan**, not a description of this code. This
matrix is the honest trace between the two: it says what exists, what exists
only in part, and what is still missing. An item marked *partly* means the
behaviour exists but not every rule the checklist asks for.

State values:

| State | Meaning |
| --- | --- |
| Implemented | The behaviour exists and the safety rules of the checklist are enforced |
| Partly | A bounded version exists; the checklist asks for more |
| Open | Not implemented in this repository |
| Out of scope | The checklist itself recommends not building it now |

## Module 01 — Main agent and multi-agent cooperation

| Item | State | Where | Gap |
| --- | --- | --- | --- |
| A01 Natural-language task understanding | Partly | `app/agent-core.mjs`, Phase 149/150 chat window | Intent routing plus model planning; no domain-level goal parser |
| A02 Automatic task decomposition | Partly | `app/agent-core.mjs` plan validation | Plans come from the model; no template library |
| A03 Specialist agent scheduling | Partly | Phase 144 skill packages, Phase 148/153 MCP tools | Capability packages exist, orchestration does not |
| A04 Parallel task execution | Open | — | Plans run step by step |
| A05 Task dependency management | Open | — | No dependency graph between plan steps |
| A06 Shared task context | Implemented | `app/task-manager.mjs`, Phase 146 event stream | — |
| A07 Result aggregation | Partly | `app/task-manager.mjs`, chat window | Results are shown, not cross-checked |
| A08 Failure retry | Open | — | — |
| A09 Task recovery after restart | Open | — | Interrupted tasks are not resumed |
| A10 Task cancellation | Implemented | `app/agent-core.mjs` `shouldCancel`/`signal`, stop button | — |
| A11 Task progress display | Implemented | Phase 146 task events, Phase 149/151 progress UI | — |
| A12 Task history | Implemented | Task history API and page | — |
| A13 Task conflict detection | Open | — | — |
| A14 Cost and resource budget | Partly | Phase 165 usage meter, Phase 166 `GET /api/models/usage`, server rate limiter | No per-task budget ceiling |
| A15 Plan and execution separation | Implemented | `app/agent-core.mjs` plan validation and execution split | — |

## Module 02 — System information and health monitoring

| Item | State | Where | Gap |
| --- | --- | --- | --- |
| S01 Hardware information | Partly | Phase 161 snapshot, trim-cli `system.*` | Board and NIC detail is not collected |
| S02 System information | Partly | trim-cli `system.kernel-version`, `system.host-name`, `system.uptime` | — |
| S03 CPU monitoring | Partly | trim-cli `monitor.cpu` | No history series |
| S04 Memory monitoring | Partly | trim-cli `monitor.memory` | Swap and pressure detail is not parsed |
| S05 Disk capacity | Partly | trim-cli `monitor.disk`, `file.usage` | — |
| S06 Disk health (SMART) | Open | — | The collector exposes no SMART source yet |
| S07 Storage pool monitoring | Partly | trim-cli `storage.pools` | Degradation interpretation is missing |
| S08 Filesystem monitoring | Partly | Phase 161 snapshot | Read-only mount detection is missing |
| S09 Network status | Partly | trim-cli `monitor.net` | Throughput and packet loss are not parsed |
| S10 Service status | Open | — | — |
| S11 Docker status | Partly | trim-cli `docker.stats`, `docker.container.ls` | — |
| S12 Temperature monitoring | Open | — | — |
| S13 System events | Open | — | — |
| S14 Historical trends | Open | — | — |
| S15 Health score | Implemented | Phase 161 `scoreHealth` | Unknown data lowers the confidence of the score |
| S16 Natural-language query | Partly | Phase 150 direct chat over registered tools | — |
| S17 Capacity forecast | Open | — | — |
| S18 Anomaly detection | Partly | Phase 162 evidence rules | No time-series baseline |
| S19 Correlation analysis | Partly | Phase 162 `rankCauses` | — |
| S20 Hardware capability assessment | Open | — | — |

Data honesty rule: a section whose collector returns nothing is reported as
`unknown` / 未采集. A value is never defaulted to a healthy-looking number.

## Module 03 — AI fault diagnosis and repair

| Item | State | Where | Gap |
| --- | --- | --- | --- |
| D01 Fault intake | Partly | Phase 162 `buildDiagnosticReport` | The symptom is supplied by the caller |
| D02 Log correlation | Open | — | Log sources are not connected yet |
| D03 Fault classification | Implemented | Phase 162 `classifyEvidence` | — |
| D04 Root-cause candidates | Implemented | Phase 162 `rankCauses` | — |
| D05 Confidence statement | Implemented | Phase 162 `confirmed` / `likely` / `suspected` | — |
| D06 Repair plan | Partly | Phase 162 `readOnlyChecks` | No side-effect statement per step |
| D07 Read-only diagnosis first | Implemented | Phase 162 read-only check list | — |
| D08 One-click repair | Open | — | Deliberately not offered without a reviewed write path |
| D09 Pre-repair checks | Open | — | — |
| D10 Post-repair verification | Open | — | — |
| D11 Failure rollback | Open | — | — |
| D12 Fault report | Implemented | Phase 162 `report`, Phase 166 `POST /api/diagnostics/report` | — |
| D13 Historical fault correlation | Open | — | — |
| D14 Repair knowledge base | Open | — | — |
| D15 Diagnostic bundle | Open | — | — |

The checker refuses destructive suggestions: `isSafeSuggestion` rejects
removal, formatting, array rebuild and storage service stops, and the report
can only escalate to a human instead of proposing them.

## Module 04 — Smart file management and search

| Item | State | Where | Gap |
| --- | --- | --- | --- |
| F01 Search by file name | Implemented | `files.list`, `files.search` | — |
| F02 Search by content | Implemented | `files.search-content` | Lexical only |
| F03 Natural-language search | Partly | Phase 150 direct chat | — |
| F04 File type classification | Implemented | `files.inspect` | — |
| F05 Search by time | Implemented | `files.search` filters | — |
| F06 Search by size | Implemented | `files.inspect`, `files.search` | — |
| F07 Duplicate file detection | Implemented | Phase 163 `detectDuplicates` | Two-stage size plus hash, bounded |
| F08 Temporary file identification | Implemented | `files.inspect` | — |
| F09 Automatic archiving | Partly | Phase 163 `planArchive` | Produces a plan, never moves files |
| F10 Batch rename | Open | — | — |
| F11 Organising preview | Implemented | Phase 163 dry-run plan | — |
| F12 Image OCR | Open | — | — |
| F13 AI gallery | Partly | trim-cli `photos.search` | — |
| F14 Photo timeline | Open | — | — |
| F15 Document summary | Partly | `documents.*` tools | Bounded text formats only |
| F16 PDF analysis | Open | — | — |
| F17 Document classification | Open | — | — |
| F18 Personal knowledge base | Partly | `documents.index-refresh` | Lexical index, no embeddings |
| F19 Question answering over files | Partly | Direct chat with `documents.search` | — |
| F20 Format conversion | Open | — | — |
| F21 Document batch processing | Open | — | — |
| F22 File change monitoring | Open | — | — |
| F23 Permission-aware search | Implemented | Storage-root confinement, symlink refusal | — |
| F24 Index management | Partly | `documents.index-status`, Phase 163 `describeIndexState` | — |
| F25 Retention policy | Partly | Bounded index and trace storage | No dedicated cleanup job |

## Module 05 — Natural-language control of the NAS

| Item | State | Where | Gap |
| --- | --- | --- | --- |
| C01 Query system state | Partly | Phase 150 chat, Phase 161 snapshot, Phase 166 `GET /api/system/snapshot` | — |
| C02 Query resource usage | Partly | trim-cli `monitor.*` | — |
| C03 Query service state | Open | — | No service collector yet |
| C04 Query disk state | Partly | trim-cli `monitor.disk` | — |
| C05 Query network state | Partly | trim-cli `monitor.net` | — |
| C06 Query Docker | Partly | trim-cli `docker.*` | — |
| C07 Control services | Open | — | No write path for service control |
| C08 Control containers | Open | — | — |
| C09 Change application configuration | Open | — | — |
| C10 Adjust resource policy | Open | — | — |
| C11 Manage shared folders | Partly | `files.*` read-only tools | — |
| C12 Manage scheduled tasks | Partly | `health-checks.*` plan lifecycle | Not created from natural language |
| C13 Result confirmation | Partly | Phase 155 observer records | — |
| C14 Operation history | Implemented | Audit log API | — |
| C15 Multi-step operations | Partly | `app/agent-core.mjs` plans | — |

Every control action goes through one execution interface. There is no
per-intent command string builder in the chat path.

## Module 06 — Docker and application management

| Item | State | Where | Gap |
| --- | --- | --- | --- |
| APP01 Container inventory | Partly | trim-cli `docker.container.ls` | — |
| APP02 Resource analysis | Partly | trim-cli `docker.stats` | — |
| APP03 Log analysis | Open | — | — |
| APP04 Dependency analysis | Open | — | — |
| APP05 Compose analysis | Partly | trim-cli `docker.compose.ls` | — |
| APP06 Deployment plan | Open | — | — |
| APP07 Pre-deployment validation | Open | — | — |
| APP08 Configuration diff | Open | — | — |
| APP09 Deploy or update | Open | — | — |
| APP10 Health check | Partly | `health-checks.*` Docker plan | — |
| APP11 Fault recovery | Open | — | — |
| APP12 Image management | Partly | trim-cli `docker.image.ls` | No update status |
| APP13 Orphan resource check | Open | — | — |
| APP14 Port conflict diagnosis | Open | — | — |
| APP15 Application migration | Open | — | — |
| APP16 Deployment rollback | Open | — | — |
| APP17 Application backup | Open | — | — |
| APP18 Application templates | Open | — | — |

## Module 07 — Network diagnosis and repair

| Item | State | Where | Gap |
| --- | --- | --- | --- |
| N01 Interface detection | Partly | trim-cli `monitor.net` | — |
| N02 DNS diagnosis | Open | — | — |
| N03 Gateway detection | Open | — | — |
| N04 Port detection | Partly | Server port state only | No host-wide port inventory |
| N05 Service connectivity | Open | — | — |
| N06 Throughput analysis | Open | — | — |
| N07 Connection failure location | Open | — | — |
| N08 Certificate check | Open | — | — |
| N09 Reverse proxy check | Open | — | — |
| N10 Repair advice | Partly | Phase 162 read-only checks | — |
| N11 Network configuration change | Open | — | No remote-access-safe change path exists |
| N12 Connectivity inspection | Open | — | — |

## Module 08 — Security audit and permission control

| Item | State | Where | Gap |
| --- | --- | --- | --- |
| SEC01 Least privilege | Implemented | `app/tool-registry.mjs`, `app/execution-policy.mjs` | — |
| SEC02 Identity check | Implemented | Session authentication and origin checks | — |
| SEC03 Tool permission table | Implemented | Phase 160 `buildToolPermissionTable`, Phase 166 `GET /api/security/inspection` | — |
| SEC04 Risk grading | Implemented | `read-only` / `write` / `destructive` | — |
| SEC05 High-risk confirmation | Implemented | `app/action-approval-service.mjs` | — |
| SEC06 Operation audit | Implemented | `app/audit-log.mjs` | — |
| SEC07 Sensitive data protection | Implemented | Phase 145 rules, Phase 146 structured logger, Phase 160 `maskSecret` | — |
| SEC08 Command injection defence | Implemented | Phase 145 dangerous-command rules, command allowlists | — |
| SEC09 Path confinement | Implemented | Storage-root confinement, no symlink following | — |
| SEC10 Server-side revalidation | Implemented | Every tool revalidates on the server | — |
| SEC11 Prompt-injection defence | Partly | Tool boundary: model output can only request registered tools | No explicit injection detector |
| SEC12 Delete protection | Partly | Delete tools show the target before execution | — |
| SEC13 Backup pre-check | Open | — | — |
| SEC14 Rollback strategy | Partly | Phase 163 archive plan is reversible by construction | No generic rollback |
| SEC15 Rate limiting | Implemented | Server rate limiter | — |
| SEC16 Emergency stop | Partly | Stop generation, cancel task | No global kill switch |
| SEC17 Security inspection | Implemented | Phase 160 `runSecurityInspection` | — |
| SEC18 Audit report | Implemented | Phase 160 report sections | — |

Permission levels L0 to L3 map onto the tool risk grades: L0 read-only, L1
diagnostics and previews, L2 approved changes, L3 destructive actions that
require an explicit confirmation with a server-issued capability.

## Module 09 — Workflow engine and scheduled tasks

| Item | State | Where | Gap |
| --- | --- | --- | --- |
| W01 Create a task from natural language | Partly | `health-checks.*` API | No natural-language creation yet |
| W02 Cron and calendar scheduling | Partly | Health-check plans | Calendar rules are missing |
| W03 Event triggering | Open | — | — |
| W04 Multi-step orchestration | Partly | `app/agent-core.mjs` plans | Plans are not persisted as workflows |
| W05 Conditional branches | Open | — | — |
| W06 Failure handling | Partly | Failure records are kept | No retry or skip policy |
| W07 Idempotency control | Open | — | — |
| W08 Task lock | Open | — | — |
| W09 Execution record | Implemented | Health-check history, task history | — |
| W10 Notification system | Open | — | No delivery targets yet |
| W11 Task templates | Open | — | — |
| W12 Workflow versioning | Open | — | — |
| W13 Pause and resume | Partly | Health-check pause and resume | — |
| W14 Task simulation | Partly | Phase 163 dry-run plan | — |
| W15 Workflow reuse | Open | — | — |
| W16 Scheduler health | Partly | `health-checks.list` | — |

Automatic inspection and automatic change stay separate: a plan may scan and
warn, but a plan that changes data needs approval.

## Module 10 — Browser, web search and external information

| Item | State | Where | Gap |
| --- | --- | --- | --- |
| B01 Web search | Open | — | — |
| B02 Official documentation first | Open | — | — |
| B03 Log and error-code lookup | Open | — | — |
| B04 Page content extraction | Open | — | — |
| B05 Page change monitoring | Open | — | — |
| B06 Version lookup | Open | — | — |
| B07 External API calls | Open | — | — |
| B08 Web operation planning | Open | — | — |
| B09 Source citation | Open | — | — |
| B10 Untrusted content isolation | Partly | Web content cannot reach tools because no web tool exists | Must be re-checked when a web tool is added |

## Module 11 — Local models, cloud models and privacy mode

| Item | State | Where | Gap |
| --- | --- | --- | --- |
| AI01 Provider configuration | Implemented | `app/model-provider-store.mjs`, Phase 154 settings UI | — |
| AI02 Local model support | Partly | Local provider entries | No resource assessment |
| AI03 Cloud model support | Implemented | Provider store plus Phase 150 adapter | — |
| AI04 Task routing | Open | — | — |
| AI05 Privacy mode | Partly | Phase 165 `applyPrivacyMode` | Not yet enforced server-side for every call |
| AI06 Model switching | Partly | Per-task model selection | — |
| AI07 Model capability configuration | Implemented | Phase 165 `describeModelCapabilities` | — |
| AI08 Call cost statistics | Implemented | Phase 165 usage meter | — |
| AI09 Timeout and degradation | Partly | Direct-chat timeout | No automatic fallback chain |
| AI10 Data masking | Partly | Log and snippet redaction | Prompt-side masking is missing |
| AI11 Model health | Partly | Provider store health state | — |
| AI12 Task reproduction | Partly | Tool trace and task history | — |
| AI13 Provider adapter layer | Implemented | `app/model-chat-adapter.mjs` | — |
| AI14 Local inference resource assessment | Open | — | — |

Missing capabilities are reported as unknown, never as a working feature.

## Module 12 — Personal knowledge base and long-term memory

| Item | State | Where | Gap |
| --- | --- | --- | --- |
| K01 Operations knowledge base | Partly | Documents under `docs/`, document index | No editable runbook store |
| K02 Historical fault library | Open | — | — |
| K03 Device profile | Open | — | — |
| K04 Application profile | Open | — | — |
| K05 User preferences | Open | — | — |
| K06 Semantic retrieval | Partly | Term and bigram ranking | No embeddings |
| K07 Source citation | Partly | Index results carry their file | — |
| K08 Stale information management | Open | — | — |
| K09 Memory correction | Open | — | — |
| K10 Knowledge update prompt | Open | — | — |

The index holds a snapshot. The live state always comes from a fresh
collection, never from the index.

## Module 13 — Mobile remote control and multi-device management

| Item | State | Where | Gap |
| --- | --- | --- | --- |
| R01 Mobile adaptation | Partly | Responsive web console | — |
| R02 Remote status view | Partly | Dashboard pages | — |
| R03 Remote conversation | Partly | Phase 149/150 chat window | — |
| R04 Remote approval | Partly | Pending action API | — |
| R05 Alert push | Open | — | — |
| R06 Multi-NAS management | Open | — | — |
| R07 Device groups | Open | — | — |
| R08 Remote task management | Partly | Task history and cancel | — |
| R09 Device status sync | Open | — | — |
| R10 Remote access protection | Partly | Authentication, session, VPN guidance | Not exposed publicly by default |

## Module 14 — Skill system and MCP extension

| Item | State | Where | Gap |
| --- | --- | --- | --- |
| SK01 Skill registration | Implemented | Phase 144 package parser, Phase 147 registry | — |
| SK02 Skill inventory | Implemented | Skill list API | — |
| SK03 Skill discovery | Partly | Name and description matching | — |
| SK04 Skill composition | Open | — | — |
| SK05 Skill versioning | Partly | Manifest version field | — |
| SK06 Skill permission declaration | Partly | Manifest declaration plus per-tool risk | — |
| SK07 Install and uninstall | Implemented | `app/skill-installer.mjs` | — |
| SK08 Skill health check | Partly | `app/skill-source-review.mjs` | — |
| SK09 MCP client | Implemented | Phase 148 `app/mcp-client.mjs` | — |
| SK10 MCP server | Implemented | Phase 164 `app/mcp-server.mjs`, Phase 166 `app/mcp-stdio-entry.mjs` | Read-only tools only |
| SK11 Tool call audit | Implemented | Phase 146 trace, Phase 155 observer | — |
| SK12 Skill isolation | Partly | Directory confinement, no auto-execution on import | No network sandbox per skill |

An MCP tool never inherits NAS access: a foreign tool is published with the
risk of the action it performs and goes through the same execution policy.

## Module 15 — Web console and interaction experience

| Item | State | Where | Gap |
| --- | --- | --- | --- |
| UI01 Unified home | Partly | Dashboard | Alerts and task status are not aggregated |
| UI02 AI conversation workspace | Implemented | Phase 149/151 chat window | — |
| UI03 Task detail page | Partly | Task history | No per-step timing |
| UI04 System monitoring page | Partly | Monitoring widgets | Phase 161 snapshot is not rendered yet |
| UI05 Storage page | Partly | Storage widgets | — |
| UI06 Application page | Open | — | — |
| UI07 File and knowledge page | Partly | Document index page | — |
| UI08 Workflow page | Partly | Health-check plan page | — |
| UI09 Security audit page | Partly | Phase 160 inspection | Rendered as a section, not a page |
| UI10 Settings page | Partly | Settings and Phase 154 model settings | — |
| UI11 Notification centre | Open | — | — |
| UI12 Live progress | Implemented | Phase 146 server-sent events | — |
| UI13 Result formatting | Partly | Unit formatting in widgets | Not unified across pages |
| UI14 Empty and error states | Partly | Error and empty states exist per widget | Not unified |
| UI15 Responsive layout | Partly | Mobile stylesheet | — |
| UI16 Accessibility | Partly | Labels and focus order | No automated check |
| UI17 Frontend/backend separation | Implemented | The server validates, executes and authorises | — |
| UI18 Unified API error format | Implemented | `reply()` error envelope | — |

## Module 16 — Logging, observability and developer capability

| Item | State | Where | Gap |
| --- | --- | --- | --- |
| O01 Unified structured log | Implemented | Phase 146 `app/structured-logger.mjs` | — |
| O02 Request chain trace | Implemented | Phase 146 trace, Phase 155 observer | — |
| O03 Metric collection | Partly | Latency counters | No exporter |
| O04 Health check API | Implemented | `/api/health` | — |
| O05 Runtime status page | Partly | MCP status and tool source views | — |
| O06 Error aggregation | Implemented | Phase 160 `repeatedErrors` | — |
| O07 Debug mode | Partly | Diagnostic bundles in the trace | No separate switch |
| O08 Configuration validation | Implemented | Release gates and startup checks | — |
| O09 Version information | Partly | MCP server info | No single build banner |
| O10 Upgrade check | Open | — | — |
| O11 Regression tests | Implemented | `tests/` suite and phase test files | — |
| O12 Deployment verification | Implemented | FPK CI build job | — |
| O13 Failure recovery test | Partly | Task cancel and timeout tests | No crash-restart test |
| O14 Resource protection | Partly | Bounded traces, indexes and queues | — |
| O15 Release check | Implemented | `scripts/check-release-gates.mjs` | — |

## What the checklist still asks for

Ordered by the checklist's own priority and by how much the gap blocks the
operating loop:

1. **Diagnosis source connection (D02, S06, S10, S13).** The diagnosis engine
   ranks causes from evidence, but no log, SMART or service-event source feeds
   it yet. This is the largest remaining gap in the loop.
2. **Verified write paths (C07–C10, APP09, D08–D11).** Every mutation is
   still absent. They must arrive one at a time, each with a preview, a
   capability-issued approval and a verification step.
3. **Workflow engine (W02–W08, W10).** Health-check plans are the seed, but
   there is no dependency graph, no lock and no notification target.
4. **Knowledge and history (K01–K10, D13, D14).** The repository has the
   documents, not the runbook store.
5. **Web information (B01–B10).** Blocked on an explicit network policy and
   SSRF protection, and on B10 being re-verified when the first web tool
   lands.
6. **Multi-device and remote (R01–R10).** Out of scope for a single-device
   console; the access guidance already prefers a private overlay.

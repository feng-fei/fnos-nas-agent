# Marvis-inspired feature parity for fnOS NAS Agent

This document translates public Marvis product capabilities into a native fnOS NAS product scope. It is a capability reference, not a claim that Marvis source code is available or that its internal implementation is being copied.

## Product direction

Build a persistent, mobile-friendly NAS AI operator that understands storage, files, applications, services, and system health. Keep the current Node.js runtime and FPK delivery. All model output remains untrusted; it can only request registered tools. Do not add arbitrary shell execution to chat or permit a Skill to bypass policy/approval.

## Capability mapping

| Marvis product capability | fnOS equivalent | Current state | Next implementation |
| --- | --- | --- | --- |
| Natural-language computer/system management | Read-only fnOS system, storage, network and Docker tools | Foundation exists | Add diagnostic summaries and safe remediation plans; mutations stay approval-gated |
| File assistant: find, inspect and manage files | Scoped volume browsing, preview, write/move/rename/delete with policy controls | Foundation exists | Content search begins in this milestone; harden coverage with tests |
| Local knowledge base | Bounded document index and retrieval within configured volumes | Not complete | Add incremental metadata/content index, freshness tracking, explicit rebuild/delete controls |
| Image understanding and gallery | fnOS photo-folder/search adapter | Basic provider tools exist | Verify the official query semantics; add metadata/EXIF/OCR only where a supported API or safe local parser exists |
| Document understanding | Bounded extraction of text from supported formats | Plain-text preview exists | Add UTF-8/Markdown/CSV first; later add optional PDF/DOCX/XLSX extraction with size/page limits |
| Browser and web information | Safe URL fetch/search through a constrained provider or Skill | Partial / not a first-class NAS tool | Add explicit network policy, host validation and SSRF protections before web-fetch tools |
| Specialist agents and delegation | Coordinator plus bounded domain plans for storage, files, Docker, network and diagnostics | Coordinator and structured plans exist; specialist orchestration is not complete | Start with deterministic domain routing and reusable read-only workflows; only split agents when it improves reliability |
| Skill library | Review, quarantine, import, lifecycle and audit controls | Foundation exists | Continue source-review and directory-confinement hardening; no auto-execution on import |
| Scheduled tasks and proactive monitoring | Periodic read-only health checks, results history and alerts | Task tracking exists; full scheduler/alerts are incomplete | Add configurable checks, retention and notification targets, with network/offline policy |
| Mobile remote operation | Mobile-friendly authenticated Web console on LAN | Foundation exists | Improve responsive workflow and task history; remote access must be explicitly configured and must not default to public exposure |
| Cross-device account and cloud computer | Not a direct v0.1 target | Not implemented | Keep out of scope unless there is a clear NAS use case and a safe product design |

## Milestone started here: bounded text-content search

The files.search-content tool adds a first content-based file retrieval primitive alongside existing filename search:

- Searches common UTF-8 text/code/document formats under configured storage roots.
- Skips symbolic links, common secret/credential filenames, binary files, and oversized files.
- Opens directories/files with Linux descriptor and no-follow checks, validates file identity, and bounds traversal depth, entries, file size, total bytes, result count and elapsed time.
- Returns one matching line per file with a short snippet; common credential assignments and token-like values are redacted.
- Reports when results may be partial. It does not persist an index or send file contents to an external service itself.

This is lexical content search, not semantic/vector search, full PDF/OCR parsing, or a persistent knowledge base. Those are later milestones and need their own privacy and resource controls.

## Recommended delivery order

1. Complete security regression work and validate the branch against CI.
2. Finish user-facing output and task progress/approval UX.
3. Add incremental local document indexing with bounded extraction and a reindex/status API.
4. Add storage and file hygiene reports (large files, stale files, sensitive-file names) as read-only tools.
5. Add scheduled health checks and notifications with retention and pause/disable controls.
6. Add specialist task routes (storage, file/document, Docker, network/system) over existing registered tools.
7. Expand into optional OCR and photo metadata search after resource measurement on supported fnOS hardware.
8. Validate FPK install, upgrade, rollback and uninstall on a real disposable fnOS device before declaring a release ready.

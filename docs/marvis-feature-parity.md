# Marvis-inspired feature parity for fnOS NAS Agent

This document maps public Marvis-style capabilities to a native fnOS NAS assistant. It is a product and implementation roadmap; it does not claim that Tencent Marvis source code is public or that its internal implementation is copied.

## Product direction

Build a persistent, mobile-friendly NAS AI operator that can find files, understand local document/photo metadata, diagnose storage and services, and run proactive checks. Keep the current lightweight Node.js runtime and FPK delivery. Model output is untrusted and can request only registered tools. Do not expose arbitrary shell execution to chat or let a Skill bypass the policy and approval layers.

## Capability mapping

| Marvis-style capability | fnOS equivalent | Status | Remaining work |
| --- | --- | --- | --- |
| Natural-language computer/system management | Registered fnOS system, storage, network and Docker tools | Foundation exists | Improve diagnostics and safe remediation plans; all state-changing actions remain approval-gated |
| File assistant | Scoped volume browsing, content search, hygiene reports and guarded file operations | Implemented in layers | Add more useful organization suggestions and polish the user-facing results |
| Local knowledge base | Persistent bounded text index with incremental refresh and retrieval | First lexical implementation delivered | Add optional document-format extraction and, later, privacy-preserving semantic search |
| Photo gallery | Search local images by name, EXIF capture date, camera brand, category, dimensions, and GPS-metadata presence | First local metadata search in this milestone | Add opt-in OCR/image understanding only after resource and privacy validation |
| Document understanding | Bounded text retrieval from supported UTF-8 text formats | Basic text support delivered | Optional PDF/DOCX/XLSX parsers with page/size limits; no automatic upload of NAS content |
| Proactive assistant | Scheduled read-only system, storage, network, Docker and document-index checks with bounded result history | Implemented; API and tools are available | Add explicit notification targets and delivery controls |
| Specialist agents | Coordinator and structured plans over registered tools | Coordinator foundation exists | Add focused storage, file/document, Docker and network diagnostic flows before introducing more agent complexity |
| Skill library | Review, quarantine, import, lifecycle and audit controls | Foundation exists | Continue source-review and directory-confinement hardening; never auto-run an imported Skill |
| Browser information | Constrained URL fetch and search | Partial | Explicit network policy, destination validation and SSRF protections are prerequisites |
| Mobile remote operation | Authenticated, mobile-friendly LAN Web console | Foundation exists | Improve responsive task/approval/history UI; remote access must never be public by default |

## Implemented capabilities

### 1. Bounded file-content search

The `files.search-content` tool searches common UTF-8 text/code formats under configured storage roots. It skips symlinks, common sensitive filenames, binary or oversized files, caps total bytes and traversal, and redacts common credential/token patterns from returned snippets. This is lexical search, not semantic/vector search.

### 2. Read-only file-hygiene inspection

The `files.inspect` tool reports largest files/directories, old large files, temporary/backup filename candidates and suspicious sensitive filenames. It only reads file-system metadata, never reads file bodies, and never moves or deletes NAS files. Traversal depth, visit count, execution time and result count are bounded. Sensitive-name directories are reported as candidates but not traversed. Partial results are marked.

### 3. Incremental local document index

The `documents.index-refresh` tool builds or refreshes a private app-data index for bounded UTF-8 text, Markdown, CSV/TSV, JSON/YAML, HTML/XML and log files. It stores capped term sets and short redacted excerpts, not full document bodies. `documents.search` uses keyword and Chinese bigram overlap; `documents.index-status` reports index counts, update time and partial-scan status. Unchanged files are skipped by size/mtime unless a forced refresh is requested. PDF/OCR extraction and semantic vectors are not included in this first version.

### 4. Scheduled read-only health checks

The `health-checks.*` tools and authenticated API can create, list, manually run, pause, resume, update and delete scheduled checks. The initial check types cover system memory/load, storage usage, network interfaces, Docker statistics and local document-index status. Plans and the latest finite history persist in the app-data directory. Execution uses registered read-only tools; summaries are bounded and errors do not persist arbitrary command output. External notifications and automatic remediation remain future work.

### 5. Local photo metadata search (current milestone)

The `media.photos.search` tool searches image files inside configured storage roots. It supports filename/camera/date queries, date ranges, category filters (photo, screenshot, scan, other), and filtering by GPS-metadata presence. The parser reads only a capped image header, supports JPEG EXIF camera brand/capture date/GPS-presence metadata and basic PNG/GIF/WebP dimensions, and reports file modification date when capture time is unavailable. It never returns GPS coordinates and never uploads image content.

Limits are deliberately small for NAS responsiveness: at most 2,500 visited entries, depth 8, 3 seconds, 128 KiB per image header, 4 MiB total header reads, and 50 results. Symlinks, common secret directories, and sensitive-name entries are skipped. This is metadata discovery, not semantic image recognition, face recognition, OCR, or a persistent photo index.

## Recommended delivery order

1. Validate and merge the local photo metadata search after Node tests and release/FPK CI pass.
2. Polish the task progress, approval, document-search and health-check UI.
3. Add opt-in PDF/DOCX/XLSX text extraction with strict page, file-size, total-byte and timeout limits.
4. Add scheduled-check notification channels only after configuration, failure reporting, and delivery-target privacy controls are defined.
5. Add focused diagnostic workflows for storage, files/documents, Docker, and network/system using registered tools.
6. Evaluate OCR and semantic document/photo search on actual supported fnOS hardware before adding native dependencies or model runtime overhead.
7. Add constrained web-information tools only after explicit network policy and SSRF protections are validated.
8. Verify FPK install, upgrade, rollback and uninstall on a disposable real fnOS device before declaring a release ready.

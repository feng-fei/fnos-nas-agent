# Phase 103 — Bounded Skill source static review

Extends the existing manifest-only review with an advisory scan of selected source and script files inside a validated Skill ZIP.

- Inspects shell, Python, JavaScript/TypeScript, PowerShell, Ruby, PHP, Go/Rust, service, YAML/JSON/TOML files in memory. It never extracts source paths to disk or executes content.
- Reads at most 32 source files, 64 KiB per file, and 512 KiB total. Archives remain under the existing entry count and total uncompressed-size limits.
- Reports standardized findings for shell execution APIs, dynamic evaluation, download-to-shell pipes, privilege escalation commands, destructive system commands, and sensitive credential/key paths.
- Oversized, invalid UTF-8, unreadable, or over-budget source files are marked as incomplete review rather than treated as clean.
- Findings remain advisory and cause the Skill to stay in the existing pending-review workflow; this is not an automatic malware verdict or security certification.
- The mobile review card shows the scanned source-file/byte count and findings so reviewers can triage the archive before approval.

Validation uses generated ZIP fixtures and Node.js 26 tests. Source contents are only read as bounded text and never executed; no real NAS is contacted.

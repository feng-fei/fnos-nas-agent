# Phase 36 — Bounded Agent File Upload

- Register `files.upload` as a routine write tool; no repeated confirmation.
- Accept strict canonical Base64, decode and re-encode to reject non-canonical payloads.
- Limit Agent uploads to 1 MiB before writing, while the existing file-manager upload API retains its separate 25 MiB ceiling for trusted callers.
- Reuse safe storage-root validation, no-overwrite semantics, exclusive temporary files, fsync, and link-based publication.
- Test binary payloads, overwrite conflicts, invalid Base64, and oversized payloads.
- No HTTP endpoint or arbitrary command execution is enabled by this phase. CI must pass on Node.js 26.x and build the FPK before merge.

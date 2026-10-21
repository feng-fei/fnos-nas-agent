# Phase 108 — File SHA-256 checksum

Adds an authenticated, read-only checksum operation to the mobile file browser.

- Calculates SHA-256 from a file inside the configured storage roots and returns the file name, path, byte count, algorithm, and digest.
- Uses a 1 MiB streaming buffer; it does not load the entire file into memory.
- Caps each file at 256 MiB to bound disk I/O on a lightweight NAS.
- Refuses directories, symlinks/out-of-root paths, oversized files, and files whose size or high-resolution modification/change timestamps shift while hashing.
- Exposes a GET endpoint protected by the existing session plus a per-session rate limit of five requests per minute.
- The mobile file row displays the returned digest as text; no file data or digest is persisted to task history.

Validation: unit tests compare against Node's SHA-256 implementation and cover empty files, symlinks, outside-root paths, size limits, concurrent modification, and API/UI contracts under Node.js 26. No real NAS is contacted.

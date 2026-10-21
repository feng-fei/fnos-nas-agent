# Phase 83 — Sequential mobile multi-file upload

The mobile file browser can select multiple files and upload them sequentially to the current directory.

- A batch is limited to 20 files, and every selected file is checked against the existing 25 MiB per-file limit before any upload starts.
- Aggregate progress reflects completed files and current-file byte progress.
- Cancellation or a failure stops the queue; already completed uploads remain in place and are reported as partial success.
- Existing server-side configured-root checks, filename validation, and no-overwrite behavior remain authoritative.
- After cancellation or partial failure, the UI refreshes the directory so the user can inspect the final state.

Node.js 26 CI checks the UI contract. This is not a real-NAS test.

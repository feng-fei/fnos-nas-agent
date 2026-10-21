# Phase 80 — Skill archive upload progress and cancellation

The mobile Skill ZIP import form now shows browser upload progress and provides a cancel button while the upload request is active.

- The browser rejects files larger than 25 MiB before sending.
- Progress is based on bytes transmitted by the browser.
- Cancelling aborts the browser's HTTP request. If the server already received and completed the upload, cancellation cannot roll back a completed quarantine operation; refresh the Skill list to confirm the final state.
- Imported archives remain quarantined and statically reviewed; this UI does not unzip or execute Skill code.

Node.js 26 CI checks the progress/cancel UI contract. This is not a real-NAS test.

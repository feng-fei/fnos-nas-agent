# Phase 85 — File transfer HTTP integration

Adds end-to-end coverage for authenticated file upload, bounded text preview, and download using a temporary configured storage root.

- Verifies upload metadata and persisted bytes.
- Confirms a duplicate upload returns a conflict and does not overwrite the existing file.
- Confirms preview and download return the uploaded content.
- Verifies no-store/nosniff download headers, same-origin enforcement, and rejection of upload paths outside the configured root.
- Tests start the actual HTTP server in an isolated temporary directory; they do not contact a real NAS or external service.

Node.js 26 CI is the validation target.

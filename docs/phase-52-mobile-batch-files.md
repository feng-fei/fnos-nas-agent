# Phase 52 — Mobile Batch File Actions

Adds multi-select actions to the mobile file browser, using the authenticated Phase 51 batch endpoint.

- Select files and folders from the current directory.
- Move the selected items into one destination folder.
- Delete selected items only after an aggregate confirmation; each request item still carries `confirm: true`.
- Show per-item success/failure and keep failed items selected for retry.
- Selection is cleared when navigating to a different directory.

The manager still enforces configured storage roots, no-overwrite behavior, empty-directory deletion, and the 1–20 operation bound. No shell commands are exposed.

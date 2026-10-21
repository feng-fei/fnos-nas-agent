# Phase 28 — Practical read-only file browser

## Goal

Add a useful mobile-friendly file browser without enabling arbitrary file access or mutations. This is an initial practical NAS feature, not a full file manager.

## Features

- Discover fnOS volume directories named `/vol1`, `/vol2`, etc. by default.
- Optionally configure allowed absolute roots with `AGENT_FILE_ROOTS`, separated by colons.
- Authenticated `GET /api/files` endpoint supports a selected directory path and bounded page size.
- The UI lists folders and files, sorts folders first, and shows file size and modification time.
- Listing is capped at 200 entries per request; the UI requests 100 by default.
- Directory and file contents are not read. No upload, download, delete, rename, or write operation is enabled.

## Boundaries

- Paths must resolve under a configured volume root.
- Symbolic links and special files are omitted from listings; paths resolving outside allowed roots are rejected.
- The endpoint requires an authenticated session.
- This feature only lists metadata. A later file-operation phase should add preview/download and mutations separately, with explicit user confirmation for changes.

## Validation

Run `npm test` and `npm run check:release`. The file-browser tests cover directory-first bounded listing, rejecting outside paths, symlink escape handling, and missing roots.

Real fnOS staging validation is still needed to confirm the actual volume layout and service-account permissions.

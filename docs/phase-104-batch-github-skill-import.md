# Phase 104 — Batch GitHub Skill import

Adds a batch path to the existing pinned-commit GitHub ZIP importer.

- Accepts 1–5 GitHub repository-root, branch/tag ZIP, or commit archive URLs per request.
- Downloads and imports sequentially so order and cumulative byte accounting are deterministic.
- The whole batch shares a 25 MiB download budget. Each item receives only the remaining bytes as its downloader limit; if a streamed oversized response trips the cap, later items are skipped rather than attempting more downloads.
- One failed/invalid item does not roll back prior successful items; each result has an index and per-item success/error details.
- Skill names default to the repository name; an optional version note can be applied to all items.
- Requires the existing authenticated session, same-origin JSON POST, and shared five-request-per-minute rate limit.
- Uses the existing commit-pinned downloader, ZIP validator, quarantine store, and static review. No archive is extracted to disk or executed.

Validation: mocked download/import callbacks and source-level HTTP/UI contracts under Node.js 26. No real GitHub repository or NAS is contacted.

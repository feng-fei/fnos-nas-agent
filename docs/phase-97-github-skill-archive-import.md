# Phase 97 — GitHub Skill archive import

Adds a mobile-friendly option to import a Skill from a GitHub branch or tag ZIP URL without manually downloading and uploading the archive.

- Accepts only HTTPS archive URLs on `github.com` and the corresponding validated `codeload.github.com` redirect paths.
- Redirects are limited to three hops, must remain on the same repository, and may not leave the GitHub archive allowlist.
- Downloads are time-limited and bounded by the existing 25 MiB Skill archive limit; streamed bytes are counted even when Content-Length is absent.
- Requires an authenticated session, same-origin POST, JSON body, and per-session import rate limit.
- Downloaded ZIP is sent through the existing Skill archive importer into quarantine. It is not extracted or executed.
- Imported Skills still require the existing static review and lifecycle workflow.

Validation: Node.js 26 tests use mocked HTTP responses; no external repository or real NAS is contacted.

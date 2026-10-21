# Phase 102 — Immutable GitHub Skill commit pinning

Resolves each GitHub branch or tag to a commit SHA before downloading the archive. This makes the downloaded ZIP immutable for the duration of import and gives reviewers a stable source identifier.

- Branch and tag archive URLs are resolved through the fixed `api.github.com/repos/{owner}/{repo}/commits/{ref}` endpoint.
- The downloaded ZIP URL uses the resulting 40-character commit SHA, not the moving branch/tag ref.
- Plain repository URLs resolve the repository default branch first, then resolve that branch to the same immutable commit archive.
- Direct commit archive URLs are also accepted and need no extra ref lookup.
- The validated SHA is returned to the UI and persisted in the existing bounded Skill source label; the UI displays a short commit prefix.
- Metadata calls are fixed-host GET requests with timeouts and a bounded 16 KiB body. Invalid or absent SHA stops the download.
- The ZIP still goes through the existing 25 MiB cap, same-repository redirect allowlist, authentication, rate limit, quarantine and static review. No imported code is extracted or executed.

Validation: Node.js 26 mocked HTTP tests cover branch/tag resolution, commit hash validation, redirect destination checks, oversized archives and quarantine wiring. No real GitHub repository or NAS is contacted.

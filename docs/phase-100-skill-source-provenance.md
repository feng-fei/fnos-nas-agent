# Phase 100 — Skill source provenance

Records the exact Git reference used during direct GitHub ZIP import so it is easier to distinguish Skills imported from different branches or release tags.

- The archive URL parser extracts branch/tag ref metadata from supported `github.com` and `codeload.github.com` paths.
- Repository-root imports already resolve the default branch and now record the same `heads` reference metadata.
- The Skill's existing source label includes `GitHub: owner/repo@heads/ref` or `GitHub: owner/repo@tags/ref` within the existing 100-character cap.
- The import response and mobile status identify a branch or tag, but never treat it as trusted or execute it.
- Archive size limits, redirect allowlisting, authentication, rate limiting, quarantine, and static review remain unchanged.

Validation: Node.js 26 mocked response tests. No external repositories or real NAS are contacted.

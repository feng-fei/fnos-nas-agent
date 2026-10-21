# Phase 99 — GitHub repository URL shortcut

Improves remote Skill import convenience: users may paste the repository root URL as well as a branch/tag archive URL.

- Accepts only HTTPS repository root URLs on `github.com`; issue, pull request, profile, and arbitrary paths are rejected.
- Resolves the public repository's default branch through the fixed GitHub REST metadata endpoint, with a bounded response body and timeout.
- Validates the returned branch name before constructing an archive URL; user-controlled URLs never choose the metadata host.
- Reuses Phase 97's GitHub/codeload redirect allowlist, same-repository checks, timeout, 25 MiB stream limit, rate-limited authenticated POST, and quarantine import flow.
- The UI identifies when a default branch was selected. Downloaded code remains unextracted and unexecuted until the existing Skill review workflow.

Validation: Node.js 26 mocked-response tests; no real GitHub repository or NAS is contacted.

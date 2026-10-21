# Phase 63 — Skill archive review hardening

Static Skill manifest review now adds advisory findings for:

- Duplicate `name` or `description` frontmatter keys, which can cause reviewers and parsers to interpret metadata differently.
- ASCII control characters embedded in the manifest.
- Additional obfuscated or high-risk command patterns such as base64 decoding, netcat execution, inline Python/Node code and `/dev/tcp` redirection.

These findings only move the manifest into `needs_review`; they do not execute or automatically reject the archive. Existing ZIP size, path, entry-count, checksum and quarantine rules remain in place. Review remains heuristic, not a security certification.

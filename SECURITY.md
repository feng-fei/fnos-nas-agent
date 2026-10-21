# Security Policy

## Supported versions

Until the first release, only the latest development branch is considered for security fixes.

## Reporting a vulnerability

Please do not publish credentials, access tokens, private NAS logs, or exploitable details in a public issue. Use GitHub's private vulnerability reporting feature if enabled for this repository, or contact the repository maintainer privately.

Include the affected version/commit, impact, and a minimal reproduction that does not expose real secrets or personal data.

## Security principles

- Imported Skills are untrusted until reviewed.
- No arbitrary shell execution from model output.
- Destructive NAS actions are denied by default.
- Secrets must never be committed or written to logs.
- Reported issues should be triaged before public disclosure.

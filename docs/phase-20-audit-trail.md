# Phase 20: Audit Trail and Operation Trace

## Scope

- Record API request outcomes for authentication, diagnostics, Skill lifecycle, Agent requests, tasks, and allowlisted tools.
- Persist newline-delimited JSON in the private application data directory with owner-only permissions.
- Keep only a bounded current log plus one rotated generation.
- Log a fixed route label, HTTP method, status code, outcome, and timestamp. Never log request bodies, query strings, cookies, authorization headers, passwords, tokens, prompts, tool arguments, raw exceptions, or client IP addresses.
- Keep audit failures non-fatal to API handling; a logging/storage failure must not turn a safe operation into an unhandled server exception.

## Safety and privacy

Audit records are metadata, not a transcript. Health polling and the static UI are excluded to prevent high-volume noise. Route labels come from a fixed allowlist; dynamic IDs and query values are never written. The log is stored under the configured app data directory with mode 0600, and the directory is created with mode 0700.

The log is bounded by maxBytes (default 1 MiB) and keeps at most one rotated file. This is local operational evidence, not tamper-proof or remotely shipped logging.

## Acceptance

- Unit tests prove field allowlisting, sensitive-value exclusion, file permissions, rotation bounds, and rejection of unrecognized routes.
- The Node.js 26.x test suite and Node.js 26 FPK build pass.
- Existing task history regression test proves historyLimit is a retention bound, not an admission limit; queueLimit remains the queue admission control.

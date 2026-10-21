# Phase 4: Read-only NAS diagnostics

## Included

The authenticated `GET /api/diagnostics` endpoint reports a bounded snapshot using Node.js built-ins only:

- OS platform, release, architecture, Node.js version, and uptime
- CPU model, logical core count, and load averages
- total/free/used memory
- non-loopback network interface addresses
- filesystem capacity for the root filesystem and app-data filesystem

The web UI displays a compact diagnostic summary after login. The endpoint requires an authenticated session; it returns HTTP 401 without one. Responses use the existing `no-store` policy.

## Safety boundaries

- No shell commands, child processes, Docker socket access, writes, restarts, or configuration changes are performed.
- Disk paths are fixed to `/` and the configured app-data directory; errors are reported as unavailable rather than exposing exception details.
- Network addresses are visible only to an authenticated user. Use only on a trusted LAN; the current HTTP transport is not encrypted.
- This endpoint is a diagnostic snapshot, not a monitoring daemon; it does not poll in the background.

## Validation

The Node built-in test suite checks that diagnostics are denied without a session and returns expected field types after login. The normal Node 24/26 CI matrix and FPK packaging workflow remain the release gate. No production NAS was changed by this PR.

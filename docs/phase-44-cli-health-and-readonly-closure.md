# Phase 44 — Connection recovery and read-only CLI closure

## Connection health

The adapter now tracks the latest result from actual allowlisted CLI requests in process memory, without persisting profile contents, access tokens, refresh tokens, authorization codes, raw stderr, or raw output. A successful system.info probe or other registered read-only CLI tool marks the profile connected. The status becomes stale after five minutes; the next status read asks the user to probe again rather than claiming that an old result proves the current session is valid.

## Safe failure classification

CLI failures are mapped to fixed categories and recovery steps. The classifier inspects bounded process diagnostics only to select a category and never returns the diagnostics themselves.

- auth_required: OAuth session is expired or login is required. Try the official interactive refresh flow first; if refresh fails, perform a new OAuth login.
- scope_missing: the profile does not have a required trim.* scope. Re-authorize the required module scopes; refresh alone cannot add scopes.
- network_error, timeout, tls_error: check the NAS address, port, route, HTTPS certificate and timeout.
- profile_unavailable, permission_denied, executable_missing: check installation, executable permissions, data-directory ownership, and ensure the profile was created under the same service account used by the Agent.
- rate_limited, output_too_large, and unknown failures have bounded, non-sensitive guidance.

A network failure does not automatically mark OAuth as unauthenticated. Only a positive successful request marks authenticated true; an explicit authentication failure marks it false. Missing scopes and transport failures remain null.

## Read-only tool closure

The documented system info, file listing/usage, app list, Docker image list, downloads, CPU monitoring, storage pool, user information, monitor capability and photo search/folder commands remain exposed only as registered read-only tools. The tool registry uses closed argument schemas; raw commands, arbitrary shell execution, and unlisted CLI operations remain unavailable. Routine file operations continue to use the separately registered file manager rather than undocumented CLI write calls.

## Validation

New unit and integration coverage verifies error classification, secret suppression, cached health/staleness, the complete documented read-only command mapping, interactive command generation, a successful probe, simulated expired OAuth, and subsequent recovery. The UI presents status labels and next actions. Node.js 26 CI runs these tests, the safety/release invariants, and syntax checks. A real fnOS NAS remains necessary to verify the official CLI's exact runtime error wording, OAuth refresh, and module scope behavior.

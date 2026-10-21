# Phase 41 — Dynamic CLI Provider Integration Fix

## Finding

The Phase 40 server passes `binaryPathProvider` to `createTrimCliAdapter` so an enabled, reviewed fnOS Skill can supply its managed CLI path. The adapter's options destructuring omitted that property, while `resolveBinaryPath()` referenced it. This left the provider undefined and could raise a `ReferenceError` when CLI status or a read-only fnOS tool was used. Syntax checks and tests using a fixed `binaryPath` did not cover the server's actual integration path.

## Fix

- Accept `binaryPathProvider` as an optional adapter dependency, preserving fixed-path and `TRIM_CLI_PATH` behavior.
- Add a regression test proving provider resolution is used by both status and read-only invocation.
- Keep command allowlisting, argument validation, bounded output, timeout, and stderr suppression unchanged.

## Scope and validation

- Node.js 26 remains the only CI runtime.
- FPK packaging, checksum and provenance checks remain paused per development direction.
- This change does not perform OAuth login, collect authorization codes/tokens, or claim that the CLI profile is authenticated.
- CI results will be reported from the PR's actual workflow status; no real NAS is accessed or modified.

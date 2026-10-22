# Phase 39 — Official fnOS Skill Archive Compatibility

## Problem

The supplied official fnOS Skill ZIP is approximately 17.7 MB compressed and declares approximately 43.4 MB of uncompressed entries because it bundles CLI binaries for six operating-system/architecture combinations. The previous 5 MiB archive and 20 MiB uncompressed limits rejected this package before review could begin.

## Delivered

- Raise the compressed ZIP limit to 25 MiB and the total declared uncompressed limit to 64 MiB.
- Keep the 500-entry limit, 1 MiB central-directory limit, path traversal checks, duplicate-name rejection, symlink/special-file rejection, compression-method restrictions, and local/central header consistency checks.
- Update the mobile Skill import UI to show the actual size limit.
- Add a regression assertion that limits remain large enough for the supplied official package.
- Update the Phase 6 documentation and release-gate source assertions.

## Safety boundary

The archive remains in private quarantine. Import does not extract files, install the CLI, invoke OAuth, execute Skill instructions, or grant capabilities. Increasing size limits only allows the package to reach static review; it does not mark the package trusted or enabled.

## Acceptance

- The official package can pass bounded archive inspection and static manifest review.
- ZIP path/type/structure validation and SHA-256 verification remain enabled.
- Node.js 26.x core tests pass; packaging checks are restored and run in CI (see docs/phase-112 and docs/phase-123).

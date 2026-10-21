# Phase 39 — Official fnOS Skill Archive Compatibility

## Problem

The supplied official fnOS Skill ZIP is approximately 17.7 MB compressed and declares approximately 43.4 MB of uncompressed entries because it bundles CLI binaries for six operating-system/architecture combinations. The previous 5 MiB archive and 20 MiB uncompressed limits rejected this package before review could begin.

## Delivered

- Raise the compressed ZIP limit to 25 MiB and the total declared uncompressed limit to 64 MiB.
- Keep the 500-entry limit, 1 MiB central-directory limit, path traversal checks, duplicate-name rejection, symlink/special-file rejection, compression-method restrictions, and local/central header consistency checks.
- Update the mobile Skill import UI to show the actual size limit; imported archives remain quarantined until explicitly approved.
- Add a regression assertion that limits remain large enough for the supplied official package.
- Add a reviewed-install endpoint that extracts only the declared Linux x64/ARM64 `trim-cli` binary, verifies the archive digest, package manifest, ELF architecture, decompressed size and CRC, then writes the binary with mode 0700.
- Add an explicit UI confirmation before installing the CLI; arbitrary archive contents and Skill instructions are never extracted or executed.
- Route enabled official Skills to their managed CLI path and keep CLI profile storage under the private app data directory.
- Update the Phase 6 documentation and release-gate source assertions.

## Safety boundary

The full archive remains in private quarantine. A separate explicit install action is available only for an approved `fnos` record with a verified quarantined archive. It extracts only the exact Linux binary declared by `fnos/manifest.json`; no other files are written. Installation does not invoke the binary, perform OAuth, execute Skill instructions, or automatically enable the Skill.

## Remaining integration requirement

The browser-based first-time OAuth Authorization Code + PKCE flow is not implemented yet. The CLI profile is isolated under the private app data directory, but the Agent does not collect authorization codes or tokens. Until an explicit login UX is delivered, CLI commands require an already-authorized profile in that data directory. The complete Skill archive must never be blindly extracted or executed.

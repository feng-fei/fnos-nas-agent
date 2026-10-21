# Phase 40 — Reviewed Official fnOS CLI Installation

## Delivered

- Add integrity-checked extraction of a single exact ZIP entry, with bounded decompression and CRC verification.
- Add authenticated `POST /api/skills/:id/install-cli`; the Skill must be approved or enabled, named `fnos`, and backed by a quarantined archive whose path and SHA-256 match the record.
- Parse `fnos/manifest.json` and require the declared CLI path for the current supported platform.
- Support Linux x64 and Linux ARM64 only. Validate the extracted binary's ELF64 class, little-endian encoding, and machine architecture before installation.
- Install only the selected `trim-cli` binary under `<app-data>/skill-tools/<skill-id>/trim-cli`, with mode 0700. The full archive remains in quarantine.
- Add a clear UI confirmation before installing the CLI. Installation does not automatically enable the Skill or execute the binary.
- Route enabled official Skills to their managed CLI path, while allowing an explicit `TRIM_CLI_PATH` override.
- Keep CLI HOME/XDG profile data under the private app data directory, avoiding accidental writes to a global root profile.
- Cover extraction, installer restrictions, HTTP routing, audit metadata, CLI profile environment, and module syntax in tests.

## Safety boundaries

- No arbitrary archive extraction, imported Skill execution, shell execution, or OAuth code/token handling is introduced.
- Only a reviewed official package can supply the CLI binary; digest, package manifest, target architecture, output size, and CRC are checked.
- The CLI may be installed before enabling the Skill, but it is only selected automatically while an official `fnos` Skill record is enabled.
- Browser-based first-time OAuth Authorization Code + PKCE login remains unimplemented. The CLI needs an already-authorized profile stored under the private app data directory; the Agent never asks for or logs authorization codes or tokens.

## Validation

- Node.js 26 core tests and syntax checks passed for commit `de1a949f6ae24c43f1376fd6110e7dd6cb5b0a39`.
- FPK build/checksum/provenance are temporarily paused during development and must be restored before release.
- No real NAS was accessed or modified.

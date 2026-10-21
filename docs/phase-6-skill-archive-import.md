# Phase 6: Safe Skill ZIP import and quarantine

## API and UI

- Authenticated `POST /api/skills/import` accepts a raw ZIP body (`application/zip` or `application/octet-stream`).
- Required `X-Skill-Name` header; optional `X-Skill-Version` and `X-Skill-Source`.
- The mobile UI uploads a ZIP and shows the server-computed SHA-256 and quarantine metadata.
- The existing manual metadata-only registration path remains available, but its digest is not server-verified.

## Limits and validation

- Maximum uploaded archive: 5 MiB.
- Maximum ZIP entries: 500.
- Maximum declared uncompressed size across entries: 20 MiB.
- Maximum central directory: 1 MiB; maximum encoded entry name: 1 KiB.
- Rejects malformed or multi-disk archives, ZIP64, encrypted entries, unsupported compression methods, unsafe absolute/drive/backslash/NUL/dot-dot paths, duplicate entry names, symlinks, and special Unix file types.
- Checks central-directory and local-header consistency and verifies stored quarantine bytes against the computed SHA-256.
- Only stored and deflated entries are accepted. The archive is not decompressed, extracted, installed, or executed.

## Quarantine storage

The archive is stored as `<app-data>/skill-quarantine/<sha256>.zip` with restrictive directory/file permissions (0700/0600). Inventory records include the verified digest, relative quarantine path, uploaded byte size, entry count, and declared uncompressed size. No uploaded file content is logged or returned.

If inventory persistence fails after the archive is stored, an unreferenced quarantined file may remain. This is safe but may require later maintenance; the archive is never auto-executed.

## Safety boundary

- Import creates a `pending_review` record.
- `approved`, `enabled`, and `disabled` remain lifecycle metadata only.
- No extraction, dynamic import, shell command, subprocess, Docker action, system service action, or model call is introduced.
- No production NAS install, restart, or configuration change was performed.
- The web service still uses HTTP; use only on a trusted LAN and never port-forward it.

## Release gate

Before merge, run the full test suite on Node.js 26.x and the compatibility suite on Node.js 24.x, inspect CI output, and verify the Node 26 FPK packaging artifact. The ZIP validator is deliberately conservative; unsupported archive formats should fail closed rather than be accepted permissively.

# Phase 11: Static Skill Manifest Review

## Scope

- Read only a single bounded `SKILL.md` payload from a validated ZIP archive.
- Support stored and deflated entries using the existing ZIP structural validator.
- Enforce a 64 KiB manifest limit, UTF-8 validation, size verification and CRC32 integrity.
- Parse only the `name` and `description` frontmatter fields; this is deliberately not a general YAML interpreter.
- Report missing metadata and potentially dangerous command/execution-related text as review findings.
- Never extract the archive to disk, load imported modules, or execute Skill instructions.

## Interpretation

Static findings are advisory review signals, not proof that a Skill is safe or malicious. Imported content and its declared name/capabilities remain untrusted. The feature does not enable Skill execution, tool loading, shell access, write operations, or model-controlled permissions. The existing pending-review state remains the default.

## Validation

The phase adds unit tests for valid frontmatter, suspicious text, missing manifests, size bounds, and invalid ZIP data. CI must pass on Node.js 24 and 26 and produce the Node.js 26 FPK artifact before merge.

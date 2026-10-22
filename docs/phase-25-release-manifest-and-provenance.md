# Phase 25: Release Manifest and Build Provenance

## Goal

Attach a machine-readable manifest to every CI-built FPK so a reviewer can verify the exact artifact checksum and identify the source commit and workflow run that produced it.

## Manifest fields

- Artifact basename, byte size, and SHA-256.
- Repository, commit SHA, Git ref, workflow name, and run ID when supplied by GitHub Actions.
- Package name/version, Node.js version, operating-system platform, and architecture.
- An explicit declaration that the manifest is **not signed**.

The manifest intentionally excludes runner paths, environment variables, secrets, tokens, user data, and build logs.

## Verification

1. Download both the FPK and its `release-manifest.json` from the same Actions artifact.
2. Recompute SHA-256 locally and compare it with `artifact.sha256`.
3. Confirm the manifest's source commit matches the intended reviewed commit.
4. Do not treat a matching checksum as proof of publisher identity: a checksum detects accidental or malicious artifact changes only when the expected checksum is obtained through a trusted channel.

## Trust boundary

This phase provides traceability and integrity metadata, not a signed attestation, reproducible-build guarantee, or proof that a package is safe. Signature/attestation support can be added later with a defined trust root and permissions model. Node.js 26.x is the only supported development, test, and packaging runtime. Real fnOS installation, upgrade, rollback, and uninstall tests remain manual staging tasks.

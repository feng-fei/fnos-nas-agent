# Phase 26: Release Artifact Verification

## Goal

Provide a standalone, dependency-free verifier for a downloaded FPK, its sha256sum-compatible checksum file, and the Phase 25 JSON release manifest.

## Verify a downloaded artifact

Keep the three files together and run:

```sh
node scripts/verify-release-artifact.mjs fnos-nas-agent-test.fpk fnos-nas-agent-test.fpk.sha256 release-manifest.json
```

The verifier checks the artifact is a non-empty regular file, the checksum file has one well-formed SHA-256 line naming the same artifact, the computed digest matches that line, and the manifest schema, basename, byte size, digest, algorithm, and unsigned status all agree.

## Limits

- A matching checksum and manifest show internal consistency, not publisher identity.
- If an attacker can replace the FPK and both sidecar files, these checks alone cannot detect that replacement.
- The verifier does not install, extract, or execute the FPK.
- The manifest remains explicitly unsigned; signature/attestation validation requires a separately defined trust root.
- Real fnOS staging install, upgrade, rollback, and uninstall tests remain separate acceptance steps.

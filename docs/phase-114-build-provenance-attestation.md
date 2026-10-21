# Phase 114 — FPK Build Provenance Attestation

## Goal

Attach verifiable GitHub build provenance to the exact FPK produced by a successful main-branch build, without exposing attestation permissions to pull-request jobs or routine build steps.

## Workflow policy

- The FPK workflow listens to pushes on `main` as well as the existing development branches.
- The `build` job runs the full tests, release safety checks, shell/Node syntax validation, pinned fnpack build, non-extracting FPK inspection, SHA-256 calculation, release-manifest creation/verification, and artifact upload.
- A separate `attest` job declares `needs: build` and is gated to `github.ref == 'refs/heads/main'` and non-`pull_request` events.
- The attestation job downloads the test artifact from the same workflow run and verifies that the FPK, checksum sidecar, and release manifest agree before attestation.
- Only the `attest` job receives `id-token: write`, `attestations: write`, and `artifact-metadata: write`. The build job keeps read-only repository permissions.
- `actions/attest@v4` creates a signed SLSA build-provenance attestation for the FPK itself. The sidecar and manifest remain ordinary files and are not represented as signed attestations.
- CI never installs, extracts, or executes the FPK on an fnOS device.

This design follows the official [actions/attest usage and permission guidance](https://github.com/actions/attest) and [GitHub artifact attestation guide](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

## Verify

Download the FPK from the expected GitHub Actions run and check its internal bundle consistency:

```sh
node scripts/verify-release-artifact.mjs \
  fnos-nas-agent-test-node-26.fpk \
  fnos-nas-agent-test-node-26.fpk.sha256 \
  release-manifest.json
```

Verify its signed build provenance separately:

```sh
gh attestation verify fnos-nas-agent-test-node-26.fpk -R feng-fei/fnos-nas-agent
```

Review repository identity, workflow identity, source revision/ref and event against the trust policy in use. An attestation proves provenance claims for the digest; it does not prove that source code is safe, that the build is bug-free, or that the package works on a particular fnOS version.

## Security and acceptance boundaries

- Pull-request workflows build and verify the test artifact but never generate attestations or receive OIDC/attestation write permissions.
- The attestation job re-verifies the same run's artifact after downloading it, avoiding an unverified sidecar/manifest bundle.
- The JSON manifest remains explicitly unsigned. SHA-256 plus a manifest detects inconsistency but does not authenticate the publisher by itself.
- The artifact is a CI test package with 14-day retention, not a versioned production release.
- Real install/start/stop/restart/upgrade/rollback/uninstall validation remains a manual operator-led task on a disposable test NAS.

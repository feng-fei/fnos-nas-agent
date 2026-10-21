# Phase 116 — Post-signing Attestation Verification

## Goal

The attestation action must not be treated as the final gate by itself. After signing the exact FPK, the same isolated main-only job performs a cryptographic verification and enforces the expected provenance identity.

## Pipeline behavior

1. The build job must pass tests, release safety checks, shell/Node syntax checks, fnpack build, archive inspection, checksum/manifest verification and artifact upload.
2. The main-only attestation job downloads the artifact from that same workflow run and repeats the checksum/manifest check.
3. `actions/attest` signs the FPK digest and publishes the build-provenance attestation.
4. The job runs `gh attestation verify` against that FPK with explicit trust constraints:
   - repository: `feng-fei/fnos-nas-agent`
   - signer workflow: `feng-fei/fnos-nas-agent/.github/workflows/build-fpk.yml`
   - source ref: `refs/heads/main`
5. The verification command uses the job token for read access to the repository's attestation record. Any missing attestation, invalid signature, wrong repository/workflow identity, or unexpected source ref fails the job.

This closes the distinction between “the upload step returned success” and “the final artifact has a verifiable attestation from the expected workflow and main ref.”

## Manual verification

For a downloaded FPK, run both the checksum/manifest verifier and the GitHub CLI provenance verifier:

```sh
node scripts/verify-release-artifact.mjs \
  fnos-nas-agent-test-node-26.fpk \
  fnos-nas-agent-test-node-26.fpk.sha256 \
  release-manifest.json

gh attestation verify fnos-nas-agent-test-node-26.fpk \
  --repo feng-fei/fnos-nas-agent \
  --signer-workflow feng-fei/fnos-nas-agent/.github/workflows/build-fpk.yml \
  --source-ref refs/heads/main
```

Review the full verification output, not merely its exit code, when deciding whether the source revision is trusted.

## Scope and limitations

- This verification runs only after a successful main-branch build. Pull-request jobs never receive the OIDC/attestation write permissions and intentionally skip signing.
- The check validates provenance claims for an artifact digest. It does not prove that application code is safe, the FPK is bug-free, or the app works on every fnOS release.
- The downloaded FPK remains a CI test artifact, not a production release.
- Real installation, authentication, lifecycle, upgrade, rollback, uninstall and data-retention acceptance remains a separate operator-led test on a disposable non-production fnOS NAS.

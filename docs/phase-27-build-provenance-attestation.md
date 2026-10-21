# Phase 27 — Build provenance attestation

## Goal

Generate a GitHub build-provenance attestation for the Node.js 26 FPK produced by the CI workflow. Phase 26 verifies that the downloaded FPK, SHA-256 sidecar, and release manifest agree; Phase 27 adds a cryptographically verifiable statement about the build workflow and artifact digest.

## Workflow behavior

- The Node.js 24 and Node.js 26 validation matrix must succeed before the attestation job can run.
- The attestation job downloads the Node.js 26 FPK artifact from the same workflow run and re-runs the Phase 26 verifier.
- The job uses `actions/attest-build-provenance` and only grants `id-token: write` and `attestations: write` to that job, alongside `contents: read`.
- Attestation is skipped for pull-request events. It runs for eligible push and manual workflow-dispatch events.
- The FPK is not installed, extracted, or executed by the attestation job.

## Verify a downloaded artifact

Install and authenticate the GitHub CLI (`gh`) with a version supporting artifact attestations. Download the FPK from the expected workflow run, then verify the attestation against the repository identity:

```sh
gh attestation verify fnos-nas-agent-test.fpk -R feng-fei/fnos-nas-agent
```

For stricter automation, inspect the command's JSON output and enforce the expected repository, workflow identity, and source ref according to the release policy in use. A successful verification establishes that GitHub can validate the attestation's provenance claims for this digest; reviewers should still check that the repository, workflow, source revision, and event are the ones they intended to trust.

The Phase 26 checksum/manifest verification remains useful for detecting accidental corruption and internal inconsistencies:

```sh
node scripts/verify-release-artifact.mjs fnos-nas-agent-test.fpk fnos-nas-agent-test.fpk.sha256 release-manifest.json
```

## Security boundaries and limitations

- A matching SHA-256 sidecar and manifest alone do **not** authenticate the publisher.
- A GitHub attestation is stronger provenance evidence, but it does not prove that the source code is safe or that a build is bug-free.
- Do not accept an attestation merely because one exists: validate repository, workflow, source ref, and event against an explicit trust policy.
- Attestation is not an application-level digital signature over an arbitrary release statement and does not enable safe installation by itself.
- The current artifact is a CI test FPK with a 14-day artifact retention period, not a versioned production release.
- Real fnOS installation, upgrade, rollback, and uninstall testing remains a separate staging acceptance task.

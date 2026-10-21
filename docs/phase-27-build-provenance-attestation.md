# Phase 27 — Build provenance attestation

## Current implementation

Phase 112 enables CI builds of an unsigned x86 test FPK. Phase 114 adds a GitHub artifact attestation job for successful builds on `main` only:

1. The build job completes tests, release gates, syntax checks, fnpack build, archive inspection, SHA-256 generation, release-manifest validation, and test artifact upload.
2. The separate attestation job depends on the successful build job, downloads the same workflow-run artifact, and reruns the checksum/manifest verifier.
3. Only that attestation job receives `id-token: write`, `attestations: write`, and `artifact-metadata: write`. The build job and pull-request jobs do not receive these permissions.
4. The job signs the exact FPK file using `actions/attest@v4`; it does not attest the sidecar files as separate subjects and does not install, extract, or execute the package.

The job runs only when `github.ref == 'refs/heads/main'` and the event is not `pull_request`. Pull requests still run all tests and build the unsigned test artifact, but they do not receive the attestation permissions. The workflow includes main in its push triggers, so a merge can produce a main-branch attestation.

## Verify a downloaded artifact

Download the FPK from the intended GitHub Actions run and verify the signed provenance:

```sh
gh attestation verify fnos-nas-agent-test-node-26.fpk -R feng-fei/fnos-nas-agent
```

Also run the repository verifier against the accompanying checksum and release manifest:

```sh
node scripts/verify-release-artifact.mjs \
  fnos-nas-agent-test-node-26.fpk \
  fnos-nas-agent-test-node-26.fpk.sha256 \
  release-manifest.json
```

A valid attestation provides verifiable provenance claims for that artifact digest. Reviewers must still check that repository, workflow, source revision, and event match the intended trust policy. A GitHub attestation does not prove that the source code is safe, that the build is bug-free, or that a package works on a particular fnOS release. Reviewers must still validate repository, workflow, source ref, and event against their trust policy.

## Trust and staging boundaries

- The JSON release manifest is intentionally unsigned; the signed GitHub attestation is separate evidence.
- Build attestation runs only for pushes/manual dispatches whose ref is `main`, never for PR events.
- Elevated OIDC and attestation permissions remain in the dedicated job only.
- The FPK remains a CI test artifact with 14-day workflow-artifact retention, not a versioned production release.
- Real fnOS install, upgrade, rollback and uninstall validation remains a manual staging task on a disposable test NAS.

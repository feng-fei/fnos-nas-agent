# Phase 27 — Build provenance attestation (deferred)

## Status

**Not enabled in the current workflow.** The current phase 112 pipeline builds and validates an unsigned x86 CI test FPK, its SHA-256 sidecar, and an unsigned release manifest. It does not generate a GitHub build-provenance attestation or grant the workflow OIDC/attestation write permissions.

Attestation was deliberately kept separate from enabling the build: first validate that the FPK build, archive inspector, checksum and manifest work on the exact same artifact; then review provenance permissions and trust policy in a dedicated phase.

## Planned behavior

When this phase is resumed in a reviewed change, the attestation job must:

- Depend on successful core tests, release gates, package build, archive inspection and checksum/manifest verification.
- Download the artifact from the same run and run the Phase 26 verifier again before attestation.
- Grant `id-token: write` and `attestations: write` only to the dedicated attestation job, not to the test/build job.
- Skip pull-request events unless the trust policy explicitly supports them.
- Never install, extract, or execute the FPK as part of attestation.
- Document how the expected repository, workflow, source ref and event are verified.

## Verify a future attestation

For a future artifact with a valid attestation, a reviewer with GitHub CLI support can use:

```sh
gh attestation verify fnos-nas-agent-test.fpk -R feng-fei/fnos-nas-agent
```

A successful verification establishes that GitHub can validate provenance claims for the artifact digest; reviewers must still check the repository, workflow, source revision and event they intended to trust. A GitHub attestation is stronger provenance evidence, but it **does not prove that the source code is safe** or that a build is bug-free.

## Current limits

- The current artifact is a CI test FPK with 14-day artifact retention, not a versioned production release.
- The release manifest is explicitly unsigned and does not authenticate the publisher.
- Real fnOS installation, upgrade, rollback and uninstall testing remains a separate staging acceptance task.

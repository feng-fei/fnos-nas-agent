# Phase 112 — FPK CI Build and Artifact Verification

## Goal

Resume automated FPK validation after the core application stabilized, without treating a successful CI job as certification of a real fnOS installation.

## Build behavior

- Build the existing x86 package in a fresh `RUNNER_TEMP` staging directory; never add generated files to the source checkout.
- Copy the Node.js 26.x executable selected by `actions/setup-node` into `app/bin/node` so the FPK does not download a runtime during installation.
- Generate `ICON.PNG`, `ICON_256.PNG` and desktop PNG variants in staging only.
- Download official fnOS `fnpack 1.2.3` from `https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-amd64`. Verify the pinned SHA-256 before running it; fail closed if the downloaded bytes do not match the reviewed pin.
- Run `fnpack build`, require exactly one FPK output, then run the repository's non-extracting archive verifier.
- Produce a SHA-256 sidecar and Phase 25 manifest, run the Phase 26 verifier against all three files, and upload the test package/checksum/manifest for 14 days.

The fnpack version, public download URL, and expected package-layout checks follow the [official fnpack documentation](https://developer.fnnas.com/docs/cli/fnpack/). The pinned SHA-256 is also published by this [public fnpack CI workflow](https://github.com/kci-lnk/fn-fpk-builder-skill/blob/main/assets/github-actions/fpk.yml); the CI job always verifies it and will stop rather than execute a mismatched download.

## Validation gates

The latest PR commit must pass:
- `npm test` on Node.js 26.x
- `npm run check:release`
- Bash/Node syntax checks for lifecycle scripts, application sources and inline UI script
- fnpack staging prerequisite checks, package build and archive structure verification
- SHA-256 and release-manifest consistency validation

The manifest explicitly marks the artifact as unsigned. Build-provenance attestation is still disabled; it will be a separate phase with its own least-privilege review and tests.

## Not covered by CI

CI does not install, start, stop, upgrade, roll back, or uninstall an application on fnOS hardware. The produced FPK is a test artifact and is not production-ready by virtue of a green build.

Before using it outside CI, an operator must verify the exact artifact checksum and complete the disposable test-NAS checklist in [the FPK test plan](fpk-test-plan.md), recording fnOS version, artifact SHA-256, date, and outcomes. Do not run automated installation or lifecycle operations against a production NAS.

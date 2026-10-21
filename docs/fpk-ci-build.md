# FPK CI build

GitHub Actions builds an **unsigned x86 CI test FPK** from an isolated copy of `apps/fnos-nas-agent/`. On `main`, a separate job additionally produces a GitHub artifact attestation for the FPK after the exact artifact bundle is re-verified. CI does not install the package on any NAS, and a successful build or attestation is not real-device acceptance.

## Runtime policy

- Node.js 26.x is the supported development, test, and packaged runtime line.
- The CI staging folder receives the exact Node.js executable selected by `actions/setup-node`; the binary is not committed into source control or downloaded at install time on the NAS.
- The package remains x86-only because the current target NAS and bundled runtime are x86_64. A different architecture requires its own tested runtime and artifact.
- fnpack is downloaded from the official fnOS distribution URL at version 1.2.3. The workflow verifies the pinned SHA-256 before executing it and fails closed on a mismatch.

## CI pipeline

The Node.js 26.x build job:

1. Runs `npm test`, `npm run check:release`, and source/shell syntax validation.
2. Copies the app template to `RUNNER_TEMP`, bundles Node.js under `app/bin/node`, and generates the required PNG icons there. Generated files and binaries do not modify the repository checkout.
3. Validates the manifest-supporting directories and JSON config, then builds the package with fnpack 1.2.3.
4. Inspects the resulting FPK archive without extracting or executing it. The verifier rejects unsafe paths, duplicate normalized paths, empty packages, unreasonable entry counts, and missing top-level package entries.
5. Produces a SHA-256 sidecar and unsigned `release-manifest.json`, then independently checks that both agree with the artifact.
6. Uploads the FPK, checksum, and manifest as `fnos-nas-agent-test-fpk-node-26.x` for 14 days.

When the workflow runs against `main` outside a pull-request event, a separate attestation job downloads this run's artifact, verifies the sidecar and manifest again, and uses `actions/attest@v4` to create signed build provenance for the FPK. The elevated OIDC and attestation permissions are scoped to this job. Pull-request builds do not receive these permissions and do not produce an attestation.

Open the successful workflow run in GitHub Actions to download the files. Verify the downloaded set locally with:

```sh
node scripts/verify-release-artifact.mjs \
  fnos-nas-agent-test-node-26.fpk \
  fnos-nas-agent-test-node-26.fpk.sha256 \
  release-manifest.json
gh attestation verify fnos-nas-agent-test-node-26.fpk -R feng-fei/fnos-nas-agent
```

A matching checksum/manifest proves internal consistency only. The GitHub attestation adds verifiable provenance claims but does not prove that source code is safe or that the package is compatible with every fnOS release.

## Security and staging boundary

The artifact contains the developed management UI and backend; treat it as a test build, not as a certified production release. The app listens on the configured interface/port and uses HTTP, so keep it on a trusted private network and do not port-forward it directly to the public internet.

Real fnOS validation must be performed by an operator on a **disposable, non-production test NAS** using the exact artifact checksum. Cover install/first-run setup, authentication/session expiry, start/stop/restart, allowlisted read-only operations, task interruption recovery, audit/task storage permissions, upgrade, rollback, uninstall and data retention. Record the fnOS version, test date, package SHA-256, and pass/fail for each item. CI will never install, restart or modify a production NAS.

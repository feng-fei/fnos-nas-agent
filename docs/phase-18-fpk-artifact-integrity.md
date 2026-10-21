# Phase 18: FPK Artifact Integrity

## Scope

- Validate the built FPK as an archive before publishing it as a CI artifact.
- Require the top-level manifest, app payload archive and launcher.
- Reject absolute paths, parent-directory traversal, duplicate normalized entries, empty artifacts, and unreasonable entry counts.
- Add fixture-based tests for valid packages, missing required entries and missing CLI arguments.

## Safety

The verifier only lists archive metadata; it does not extract or execute the package. CI continues to publish a checksum for the exact artifact. It is a structural gate, not a signature or provenance attestation.

## Acceptance

Run on Node.js 24/26 test jobs and use it in the Node.js 26 packaging job before artifact upload. Real fnOS install/upgrade validation remains a separate staging requirement.

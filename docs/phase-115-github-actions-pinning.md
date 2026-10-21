# Phase 115 — Immutable GitHub Actions References

## Goal

Prevent a moved major-version or release tag from silently changing the third-party code executed by the FPK build pipeline.

## Pinned actions

The workflow uses full 40-character commit SHAs. Each selected release ref was resolved through the official GitHub repository API, and each target commit's verification metadata reported a valid verified signature before being added here.

| Action | Reviewed release | Immutable commit |
|---|---|---|
| `actions/checkout` | [v5.1.0](https://github.com/actions/checkout/releases/tag/v5.1.0) | `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` |
| `actions/setup-node` | [v5.0.0](https://github.com/actions/setup-node/releases/tag/v5.0.0) | `a0853c24544627f65ddf259abe73b1d18a591444` |
| `actions/upload-artifact` | [v4.6.2](https://github.com/actions/upload-artifact/releases/tag/v4.6.2) | `ea165f8d65b6e75b540449e92b4886f43607fa02` |
| `actions/download-artifact` | [v4.3.0](https://github.com/actions/download-artifact/releases/tag/v4.3.0) | `d3f86a106a0bac45b974a628896c90dbdf5c8093` |
| `actions/attest` | [v4.2.2](https://github.com/actions/attest/releases/tag/v4.2.2) | `1e69f48acb82d1966a394da916b4c1698aa569d6` |

Human-readable release tags remain inline comments only; the executable reference is the full SHA. The versions were selected to use Node 24-compatible checkout/setup actions while keeping the workflow's supported Node.js 26 runtime independent from the actions' own JavaScript runtime.

## Automated safeguards

- `tests/phase-115-github-actions-pinning.test.mjs` checks the exact SHA and expected number of uses for each action.
- `npm run check:release` verifies that workflow references match the reviewed pins.
- The tests reject mutable major-version references for the actions in this list.

If an action is upgraded, first review its official release notes and full target commit, verify the commit signature, update the workflow and reviewed pin table together, and run the full FPK build/attestation CI. A full commit SHA is immutable with respect to tag movement, but does not by itself establish that the referenced code is trustworthy; release and source review are still required.

# Phase 130 — Release Consistency

## Purpose

Close the gaps found by a documentation-versus-code audit of the repository:
a missing license, a version number that existed in more than one place, CI
trigger rules that no longer matched the branch and file layout, documentation
that was not reachable from any index, and an early prototype directory that
was still being built by CI.

This phase changes no runtime behavior. It changes the repository's
release-facing surface so that what CI builds, what the docs claim, and what
the package declares agree with each other.

## Changes

### 1. MIT license lands

The repository now ships an MIT license at the root, and the README license
section points at it instead of stating that no license had been selected.

- `LICENSE` — full MIT text, copyright line `Copyright (c) 2026 fnos-nas-agent contributors`.
- `README.md` — the `## License` section now names the MIT License and links to `[LICENSE](LICENSE)`.

### 2. One version number, three consumers

`0.2.1` is the single version of this release. It is declared in exactly two
committed files and reported by exactly one runtime surface:

- `package.json` — `version`.
- `apps/fnos-nas-agent/manifest` — `version` (the version the FPK shows in the fnOS application center).
- `GET /api/health` — reports the same string, resolved from the shared runtime version module.

The FPK `manifest` description was also corrected: it previously claimed the
package "only provides a status page and performs no NAS management
operations", which contradicted the delivered file, Skill, and model features.

### 3. CI trigger rules match the repository layout

The workflow previously enumerated 30-plus `phase-N/**` branch patterns that
had not changed since Phase 28, and it did not build a pull request opened
from a `feature/**` branch. Its path filter also excluded `README.md` and
`docs/**`, even though the release gate asserts README and documentation
content — so a documentation-only change could not fail the gate that exists
to police it.

### 4. Documentation index and link test

`docs/README.md` lists every document in `docs/`, and
`tests/docs-links.test.mjs` fails when a relative link in `README.md` or
`docs/README.md` points at a missing file, or when a document in `docs/` is
not listed in the index.

### 5. The prototype directory is gone

`src/` held the first prototype server, a token-based configuration file, and
a read-only tool registry. It had been superseded by
`apps/fnos-nas-agent/app/` for a long time; only two legacy tests still
imported it, and the CI path filter still listed `src/**`, so unrelated pull
requests kept paying for it.

## Before and after

| Area | Before | After |
| --- | --- | --- |
| License | No `LICENSE` file; README said "No license has been selected yet" and warned against reuse | MIT `LICENSE` at the root; README names the MIT License and links to it |
| FPK version | `manifest` declared `0.1.0` while the repository moved independently | `manifest`, `package.json`, and `/api/health` all report `0.2.1` |
| FPK description | "仅提供状态页面，不执行 NAS 管理操作" — contradicted the delivered features | Describes mobile file management, model-provider configuration, isolated Skill review, and restricted read-only fnOS tools |
| Runtime defaults doc | `.env.example` documented `HOST=127.0.0.1`, `PORT=8787`, and an `AGENT_ACCESS_TOKEN` that the running service does not use | `.env.example` documents `HOST=0.0.0.0`, `PORT=18787` / `TRIM_SERVICE_PORT`, `AGENT_DATA_DIR`, the execution modes, and the CLI variables |
| CI branch filters | 30-plus hand-written `phase-N/**` patterns, stopping at Phase 28; pull requests from `feature/**` never ran | One `phase-*/**` pattern for push and pull request, plus `feature/**`, `fix/**`, `test/**` |
| CI path filters | `README.md` and `docs/**` excluded, `src/**` included | `README.md`, `LICENSE`, `.env.example`, and `docs/**` included; `src/**` removed |
| Node version policy | 31 documentation lines still promised a Node.js 24/26 matrix; CI ran only 26.x | All documentation states Node.js 26.x as the only supported runtime |
| Documentation reachability | 30 documents were not linked from any index; `docs/` had no index at all | `docs/README.md` lists every document; `tests/docs-links.test.mjs` keeps it complete and link-clean |
| Prototype code | `src/` plus two tests, built by CI, unused by the product | Removed, together with the two legacy tests |

## Validation

- `npm test` — includes the new documentation link test.
- `npm run check:release` — the release gate still enforces the Node.js 26.x
  matrix, the pinned actions, the FPK lifecycle smoke test, the artifact
  verification, and the documented safety boundaries.
- The CI workflow itself is the executable form of this phase: it builds the
  FPK, verifies the artifact bundle, and attests verified `main` builds.

## Boundaries

- This phase does not change runtime behavior, permission policy, or the
  release artifact format.
- It does not create a signed release. The manifest stays explicitly unsigned
  and the CI attestation remains a build-provenance claim, not a publisher
  identity or a safety guarantee.
- It does not replace the manual fnOS device acceptance gate. A green
  pipeline still does not certify installation, upgrade, rollback, or
  uninstall on a real NAS.

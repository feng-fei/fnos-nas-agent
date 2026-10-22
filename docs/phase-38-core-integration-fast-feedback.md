# Phase 38 — Core Integration and Fast Feedback

## Delivered

- Wire the configured official fnOS `trim-cli` adapter into the registered tool catalogue. Previously, the server imported the adapter but never supplied an instance to the registry, so official CLI tools could not execute even when `TRIM_CLI_PATH` was configured.
- Expose the actual adapter configuration state through the authenticated `/api/agent/status` endpoint and cover the unconfigured state in the HTTP contract test.
- Correct bounded file-search reporting so reaching the requested result limit while directories remain marks the response as truncated.
- Simplify development CI to Node.js 26 only, keeping the core test suite and syntax checks. FPK packaging, checksums, artifact upload, and provenance attestation have since been restored and run on every supported branch (see docs/phase-112 and docs/phase-123).
- Syntax-check every application and script `.mjs` file rather than a manually maintained subset.
- Update README status and CI notes to match the actual development workflow.

## Boundaries

- `TRIM_CLI_PATH` must point to an explicitly installed, executable official CLI. This change does not install or extract Skill archives, handle OAuth tokens, or execute imported Skill code.
- Arbitrary shell execution remains disabled. CLI calls remain fixed to registered commands, typed arguments, timeouts, and bounded output.
- CI runs the release gate end to end, but a green pipeline is still not evidence that the FPK is release-ready on a real NAS.
- CI success does not replace installation and smoke testing on a test fnOS NAS.

## Validation

- Node.js 26 core tests, including HTTP authentication and file-browser tests.
- Syntax checks for all application and script modules.
- FPK build and artifact verification run in the same job, and the standalone release verifier re-checks the published artifact bundle.

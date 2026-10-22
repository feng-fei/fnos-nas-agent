# Phase 33 — Practical routine file writes

## Scope

This phase exposes three already-implemented file-manager operations through the Agent's server-controlled tool catalogue:

- `files.create-folder` — create a new folder under an allowed storage root.
- `files.rename` — rename a file or folder without overwriting an existing destination.
- `files.move` — move a file or folder into an allowed destination directory without overwriting.

All three tools are classified server-side as `write`, use closed argument schemas, and reuse the file manager's storage-root, symlink, name, and destination checks. They do not ask for repeated confirmation because these are routine, reversible operations within configured storage roots.

The rules-first Agent recognizes explicit Chinese intents for creating a folder, renaming, and moving. The model can also select only registered tools with schema-validated arguments. No arbitrary shell or unregistered command execution is enabled.

## Current boundary

Deletion is intentionally not exposed as a routine write tool. It remains an operation requiring explicit confirmation. Application/service lifecycle actions, Docker mutation, network/system configuration, disk formatting, storage-pool deletion, and arbitrary shell execution are not enabled by this phase.

The API reports `routineWriteExecutionEnabled` separately from arbitrary `executionEnabled`; the latter remains false. Authenticated API access and same-origin checks still apply.

## Validation

The new tests cover tool risk/schema declarations, folder creation, rename/move, no-overwrite behavior, storage-root containment, and rules-first routing without a model call. CI must pass on Node.js 26.x. This does not replace testing on an actual fnOS NAS.

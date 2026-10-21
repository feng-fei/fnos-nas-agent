# Skill Lifecycle

## Purpose

The Skill manager supports importing and managing capability packages while keeping the Agent core independent. v0.1 treats Skills as declarative instruction/documentation packages. It does not execute arbitrary code from imported packages.

## States

`absent -> imported -> pending-review -> approved -> enabled`

Other transitions:
- `pending-review -> rejected`
- `approved -> disabled`
- `enabled -> disabled`
- `enabled -> update-pending-review`
- `disabled -> removed`

A package cannot transition itself to approved or enabled.

## Package metadata

The initial internal manifest should include:
- stable Skill ID;
- display name and description;
- package version;
- supported Agent API version range;
- source/origin and optional upstream URL;
- declared capabilities;
- entry instruction file path;
- file inventory and SHA-256 hashes;
- review state and reviewer/time;
- compatibility notes.

Do not assume the official fnOS Skill's own `manifest.json` has this schema. The manager's metadata is a separate wrapper record.

## Import and inspection

1. Accept a local ZIP or a supported repository snapshot through an explicit user action.
2. Enforce compressed and expanded size limits.
3. Reject absolute paths, `..` traversal, unsafe symlinks, duplicate normalized paths, and unsupported file types.
4. Extract only into a dedicated staging directory.
5. Parse text files as inert content; do not run scripts or binaries.
6. Produce a review report listing entry points, executable files, network references, permissions, external dependencies, and suspicious instructions.
7. Compute content hashes and keep the imported artifact immutable until a new version is reviewed.

## Approval and enablement

Approval is an administrative action separate from import. Enabling a Skill only makes its instructions available to the planner; it does not automatically register new executable tools or grant NAS permissions.

The planner must treat Skill text as untrusted context. Tool calls remain constrained by the built-in tool registry and policy engine.

## Updating and rollback

- Import updates into a separate staging version.
- Compare file inventory and hashes with the current version.
- Require review again for changed content.
- Keep the last known approved version until the new version passes review.
- Rollback changes the selected approved version; it must not alter unrelated Agent configuration.

## Removal

Removal deletes only files within the Skill manager's managed directory after path validation. It must not execute package uninstall hooks. Audit metadata may be retained without retaining package contents.

## Official fnOS Skill integration

The supplied official Skill package is the first candidate. Its instructions, task entries, reference files, and `trim-cli` binaries must be treated separately:
- instruction/reference files are read-only knowledge for the planner;
- `trim-cli` is an executable dependency and requires independent platform, integrity, and behavior review;
- CLI invocation is implemented by the built-in fnOS adapter, not by executing arbitrary commands mentioned in Skill text;
- OAuth is performed only through the documented user-authorized flow.

## v0.1 limitations

- No marketplace.
- No unattended remote installation.
- No arbitrary plugin code execution.
- No automatic permission granting.
- No automatic Skill self-update.

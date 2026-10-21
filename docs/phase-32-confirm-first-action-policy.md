# Phase 32 — Confirm-First Action Policy

## Product direction

This is a personal fnOS NAS assistant, not a corporate permission workflow. The user completes sign-in / official Skill authorization once. Routine actions should remain convenient; confirmation is reserved for meaningful risk, not every write.

## Policy contract

- Read-only actions run immediately.
- Ordinary, server-classified write actions are available by default without another confirmation prompt. Examples include creating a folder, uploading, renaming, and moving files.
- Destructive actions are available by default but require confirmation for the exact action, target, and impact before execution.
- Irreversible/high-impact operations (formatting disks, deleting pools, factory reset) require stronger typed confirmation, such as re-entering the target name.
- Confirmation grants are bound to the exact action, arguments, risk tier, and task; they expire, are single-use, and cannot be replayed for changed arguments.
- Unknown/unclassified actions remain blocked until a server-side executor classifies them. This is a classification gap, not a reason to permanently disable known useful operations.
- Never trust a model-supplied risk label or an `approved=true` field. The server must derive risk from the registered tool and validated arguments.
- Arbitrary shell execution is not enabled by this policy change alone. It should be added as a dedicated executor with command preview, server-side risk classification, output/time bounds, and confirmation for destructive commands.

## Existing implementation

- The policy now allows ordinary writes without per-action confirmation and keeps destructive actions behind explicit confirmation.
- The one-time approval ledger binds grants to task ID, tool ID, risk, and a canonical hash of the arguments, with expiry and replay prevention.
- The policy and ledger are not yet connected to a write-capable Agent executor. Existing local file-manager HTTP operations do not mean all official Skill operations are available through the Agent.

## Next implementation steps

1. Connect the approval ledger to authenticated HTTP confirmation endpoints and a mobile pending-action view for destructive operations.
2. Add useful bounded write tools using verified official fnOS commands and APIs.
3. Route Agent-proposed destructive actions into pending confirmation rather than executing them immediately.
4. Keep routine reads and writes direct; interrupt the user only for meaningful risk.
5. Add tests for confirm/deny, expiry, replay, changed arguments, unauthenticated approval, and typed confirmation for irreversible actions.

## Validation

Require Node.js 24 and 26 test suites plus Node.js 26 FPK build. CI is not real-device fnOS validation.

# Phase 32 — Confirm-First Action Policy

## Product direction

This is a personal fnOS NAS assistant, not a corporate permission workflow. Keep common operations convenient. Do not require an administrator to separately enable ordinary write/destructive capabilities just to use the assistant.

## Policy contract

- Read-only actions run immediately.
- Ordinary write actions are available by default but must receive an explicit, one-time confirmation before execution.
- Destructive actions are also available by default but require a stronger confirmation that shows the exact target and expected impact.
- Confirmation is bound to the exact action, arguments, risk tier, and task; it expires, is single-use, and cannot be replayed for changed arguments.
- Confirmation is not authorization for a different action. If the target or arguments change, obtain a new confirmation.
- Unknown/unclassified actions remain blocked until a server-side executor classifies them. This is a classification gap, not a reason to permanently disable known useful operations.
- Arbitrary shell execution is not enabled by this policy change alone. It must be added as a dedicated executor with command preview, risk classification, output/time bounds, and confirmation for dangerous commands; never trust a model-supplied risk label or an approved=true field.
- High-impact irreversible operations (formatting disks, deleting pools, factory reset) require a stronger typed confirmation, such as re-entering the target name.

## Existing implementation

- The permission policy now defaults allowWrite and allowDestructive to true, while still requiring approved=true to allow either risk tier.
- The one-time approval ledger already binds grants to task ID, tool ID, risk and a canonical hash of the arguments, with expiry and replay prevention.
- The policy and ledger are not yet connected to a write-capable Agent executor. This phase intentionally changes policy defaults and tests only; it does not pretend that write execution has been implemented.

## Next implementation steps

1. Connect the approval ledger to authenticated HTTP confirmation endpoints and a mobile pending-action view.
2. Add useful bounded write tools (start with create/rename/move file and app/container lifecycle actions where the official API is verified).
3. Route Agent-proposed write actions into a pending confirmation instead of rejecting them or executing them immediately.
4. Keep read-only actions one-tap; only interrupt the user for meaningful risk.
5. Add tests for confirm/deny, expiry, replay, changed arguments, unauthenticated approval, and dangerous-action typed confirmation.

## Validation

Require Node.js 24 and 26 test suites plus Node.js 26 FPK build. CI is not real-device fnOS validation.

# Phase 10: permission policy foundation

This phase establishes a lightweight, confirm-first risk policy for a personal NAS assistant. The user has already completed the assistant's sign-in / official Skill authorization flow; do not turn every ordinary operation into another permission ceremony.

## Policy behavior

- `read-only`: allowed by default and runs immediately.
- `write`: allowed by default without an additional confirmation prompt, for actions classified by the server as ordinary writes (for example, creating a folder, uploading, renaming, or moving a file).
- `destructive`: available by default, but requires an explicit confirmation for the exact action and target before execution (for example, deleting data, stopping services, or restarting an application when disruption is expected).
- Irreversible/high-impact operations such as formatting a disk, deleting a storage pool, or factory reset require stronger typed confirmation.
- `unknown` or unrecognized risk values remain denied. This prevents unclassified actions from being treated as safe by default.
- `allowWrite` and `allowDestructive` are capability switches, not per-operation prompts. Their default is enabled; a separate confirmation is only required for destructive actions.

## Integration contract

Risk must be classified by the server-side executor using the actual registered tool and validated arguments. Never trust a risk label or `approved` flag supplied directly by a model or browser. Destructive confirmation must be authenticated, one-time, task/action/argument-bound, short-lived, and replay-resistant. This policy module only evaluates policy; it does not execute tools or create approvals.

The official fnOS Skill / CLI remains the source of truth for supported operations. Do not invent CLI subcommands. Arbitrary shell execution is not enabled by changing this policy alone; when implemented, it needs a bounded executor, command preview, server-side risk classification, time/output limits, and confirmation for destructive commands.

## Validation

Unit tests cover default read/write behavior, destructive confirmation, opt-out overrides, unknown risk rejection, invalid configuration, and the execution-disabled invariant. CI should run Node.js 24/26 test suites and Node.js 26 FPK package inspection. CI is not real-device fnOS validation.

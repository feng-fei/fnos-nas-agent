# Phase 34 — Explicit confirmation for destructive file actions

## Behavior

- `files.delete` is registered with server-owned risk classification `destructive`.
- Direct invocation through `/api/tools/:id/run` is rejected for destructive tools.
- The Agent recognizes an explicit `删除 <path>` request and creates a pending action instead of executing it.
- The authenticated mobile UI shows the exact target, operation description, arguments, and expiry. The user must press confirm and accept a second browser confirmation before execution.
- Denial removes the pending action without invoking the tool.
- Confirmation is one-time, expires after 60 seconds, and is bound by the approval ledger to the originating task, registered tool, risk, and canonical argument hash. The client never supplies a trusted risk value or approval token.
- Pending approvals are in memory only. A process restart clears them, and expired actions are never replayed.

## Scope and safety

This phase wires the existing one-time approval ledger into a small action service and authenticated HTTP routes. It supports deleting one regular file or an empty directory, while the file manager continues to reject storage-root deletion, paths outside configured roots, symlinks, and unsupported file types.

Mixed Agent plans that combine destructive actions with other tool calls are rejected as a whole to prevent partial execution before a confirmation prompt. Arbitrary shell, application lifecycle, Docker mutation, network/system configuration, disk formatting, and storage-pool deletion remain unavailable.

## Validation

Tests cover request-without-execution, exact-target confirmation, one-time consumption, denial, expiry, unregistered tools, invalid arguments, Agent routing, authentication, and the prohibition on direct destructive tool invocation. CI must pass on Node.js 26.x. Real fnOS acceptance is still required before treating the FPK as device-verified.

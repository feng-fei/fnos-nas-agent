# Phase 13: Mobile Operations Workbench

## Scope

- Display bounded Skill manifest metadata and static review findings in the existing mobile-first Skill list.
- Allow authenticated users to cancel queued tasks or request cooperative cancellation of running tasks through a same-origin POST endpoint.
- Queued tasks are removed before execution. For running tasks, the current operation is allowed to finish and the Agent must not start follow-up tool steps; the API returns HTTP 202 to distinguish a cancellation request from a completed cancellation.
- Treat cancelled tasks as terminal history entries and show cancellation status in the Agent conversation.

## Safety

Cancellation never kills an in-flight operating-system operation and does not grant additional permissions. A running cancellation is cooperative: the active operation finishes, then the Agent stops before any follow-up tool call. The task engine remains limited to existing read-only tools. Static Skill findings are advisory and are rendered as text, not HTML. The approval ledger remains separate and does not enable execution.

## Validation

Adds unit coverage for queued cancellation, non-cancellable running tasks, and unknown IDs. CI also syntax-checks the embedded mobile UI JavaScript, Node.js server and task manager; The Node 26.x test job and Node 26 FPK packaging remain required.

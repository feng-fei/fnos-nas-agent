# Phase 50 — Mobile Task Progress UI

The mobile workbench now renders task progress using the existing task API:
- Running and queued tasks show a bounded progress bar, percentage, and stage label.
- Active task history refreshes automatically every 1.2 seconds and stops polling when no active tasks remain.
- Completion displays 100%; task errors use the existing text-only rendering path.
- Task IDs, status, timestamps, and cancellation remain available.

Agent execution now reports real stages through the existing task-manager callback: request parsing, rules match or model planning, plan validation, tool execution, and per-tool completion. The task manager still clamps progress monotonically and reserves 100% for task completion. This does not change execution permissions or persistence.

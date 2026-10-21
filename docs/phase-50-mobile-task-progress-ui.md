# Phase 50 — Mobile Task Progress UI

The mobile workbench now renders task progress using the existing task API:
- Running and queued tasks show a bounded progress bar, percentage, and stage label.
- Active task history refreshes automatically every 1.2 seconds and stops polling when no active tasks remain.
- Completion displays 100%; task errors use the existing text-only rendering path.
- Task IDs, status, timestamps, and cancellation remain available.

This phase changes only the UI presentation. It does not change execution permissions, task scheduling, persistence, or server routes.

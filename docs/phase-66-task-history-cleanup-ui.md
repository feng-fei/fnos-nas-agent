# Phase 66 — Task history cleanup control

Adds a mobile task-history action that asks for confirmation before clearing terminal records. The UI explicitly states that queued and running tasks are preserved and will not be cancelled. After cleanup it reports the number removed and refreshes the task view.

The control calls Phase 64's authenticated cleanup API. It does not send task IDs or delete active work.

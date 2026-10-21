# Phase 66 — Task history cleanup control

Adds a mobile task-history action that asks for confirmation before clearing terminal records. The UI explicitly states that queued and running tasks are preserved and will not be cancelled. After cleanup it reports the number removed and refreshes the current task view.

This UI depends on Phase 64's authenticated cleanup API and is stacked on Phase 65 to avoid concurrent edits to the same mobile UI file.

# Phase 48 — Bounded task progress reporting

This phase extends the existing task manager with a small progress contract for long-running operations.

- Executors receive a second context argument with `reportProgress(percent, stage)`.
- Progress is integer-normalized, monotonic, bounded to 0–99 while running, and set to 100 only after successful completion.
- Stage labels are trimmed and capped at 80 characters.
- Public task snapshots include progress and stage; persisted metadata includes only these bounded fields, never task inputs, prompts, results, or raw exceptions.
- Existing task concurrency, queue bounds, cancellation semantics, restart recovery, and sanitized errors remain unchanged.
- The callback returns false for invalid progress values or after the task stops running.

This is a generic contract; current task executors may not report intermediate progress until individual operations adopt it. CI does not substitute for validation on a real fnOS NAS. FPK build, checksum, artifact, and provenance jobs remain paused.

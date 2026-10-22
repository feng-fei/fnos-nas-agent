# Skill and task management UX

This change completes two practical UI gaps:

- Rejected Skill entries can be removed after an explicit confirmation. Their quarantined ZIP is deleted only when no remaining Skill record references the same SHA-256. Approved/enabled/pending entries cannot be removed directly; review them first.
- The Agent panel shows running/queued/retained task counts, and the client waits longer for long-running tasks while still allowing manual history refresh.

Skill archives remain quarantined. This lifecycle management does not execute imported Skill code or claim that an archive is safe merely because it has been approved.

Validation: Node.js 26.x tests, release gates, and Node.js 26 FPK packaging. Real fnOS validation remains separate.

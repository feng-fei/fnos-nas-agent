# Phase 81 — Sequential multi-Skill ZIP import

The mobile Skill manager accepts multiple ZIP files and imports them sequentially through the existing quarantine endpoint.

- Each archive must be at most 25 MiB; all selected files are checked before the first upload begins.
- Aggregate progress reflects completed files plus the current file's byte progress.
- A failure or cancellation stops the queue. Already completed archives remain quarantined and are reported as partial success; refresh the list to verify state.
- For multi-file selection, each Skill name is derived from the entered base name plus the selected filename, bounded to 100 characters.
- Every archive still uses the existing server-side structural validation and static review. Nothing is extracted or executed.

Node.js 26 CI checks the client workflow contract. This is not a real-NAS test.

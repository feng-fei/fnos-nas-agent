# Phase 49 — Bounded batch file operations

The file manager now exposes `operateBatch({ operations })` for grouped file actions. Batches accept 1–20 operations and execute sequentially, preserving a stable result order. A failure in one item does not hide the outcomes of later items. Each result includes its zero-based index and either a successful operation result or a generic, sanitized error message. Raw exception messages and stack traces are not returned. Existing per-operation path validation, storage-root boundaries, collision handling, and destructive-operation confirmation remain in force.

This is a manager-level API contract; no new HTTP endpoint or UI control is exposed in this phase. That avoids bypassing the existing authenticated routes and per-action confirmation flow. Tests use temporary directories and do not touch a NAS.

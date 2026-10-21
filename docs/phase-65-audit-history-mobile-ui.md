# Phase 65 — Mobile audit history filters

- Extend the authenticated audit endpoint with bounded offset pagination.
- Filter by allowlisted outcome categories (success, rejected, error) and exact audit route names.
- Return total matches and effective page metadata.
- Add mobile controls to filter, page through results, and inspect the latest metadata-only audit events.
- Keep the existing privacy boundary: no prompts, passwords, API keys, task inputs or raw exceptions are added to audit records.

Audit data remains bounded by the existing current/rotated log files. The UI renders audit entries as text, not HTML.

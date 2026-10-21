# Phase 64 — Clear terminal task history

Adds an authenticated, same-origin `POST /api/tasks/clear-history` endpoint that removes only completed, failed and cancelled task records. Queued and running tasks are preserved and never cancelled as a side effect. Cleanup is persisted and audited through the existing metadata-only audit log. If persistence fails, the removed terminal records are restored in memory.

The endpoint does not accept task IDs or arbitrary deletion paths. Automated tests verify that active work remains intact and that the route is authenticated and same-origin.

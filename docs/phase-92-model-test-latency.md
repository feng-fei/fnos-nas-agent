# Phase 92 — Persist model connection-test latency

The model provider store now persists the elapsed time and HTTP status code from the latest connection test alongside its existing safe summary.

- Duration is measured around the provider request and stored as a non-negative integer.
- HTTP status is retained only when it is a valid integer from 100 through 599.
- Reload sanitizes both fields and ignores malformed values in older or edited store files.
- Existing safe error summaries remain unchanged; provider response bodies and API keys are never stored.
- The API exposes the metadata through the existing public provider record.

Node.js 26 tests verify latency and status survive store reload without exposing secrets.

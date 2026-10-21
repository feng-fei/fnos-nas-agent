# Phase 93 — Model connection diagnostics in the UI

Model provider cards now show the latest connection-test duration and HTTP status code when available. The bounded batch tester also includes each provider's elapsed time in its result summary.

- Duration and status are displayed only when the values pass basic integer validation.
- Existing stored records without diagnostics remain supported.
- No API key or raw provider response content is displayed.
- The UI uses the existing provider summary and does not make additional requests.

Node.js 26 static UI contract tests cover both single-provider and batch result diagnostics.

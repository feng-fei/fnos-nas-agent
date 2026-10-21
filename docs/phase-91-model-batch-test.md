# Phase 91 — Bounded batch model connection testing

Adds a mobile-friendly batch action to test configured model providers without firing an unbounded burst of requests.

- Tests enabled providers that have an API key.
- Runs requests sequentially, at most five providers per click.
- Shows per-provider success/failure details and batch progress.
- If more providers remain, the next click continues from the next provider; once all have been tested, the next cycle starts over.
- Uses the existing authenticated connection-test endpoint and its per-session rate limiter.
- No API keys are shown or copied into the UI status text.

The change is UI-only and is covered by a Node.js 26 static contract test. Connection tests themselves still use the existing bounded endpoint timeout.

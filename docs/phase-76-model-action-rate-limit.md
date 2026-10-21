# Phase 76 — Model action rate limiting

The authenticated model catalog discovery and connection-test actions share a per-session fixed-window limit of 10 attempts per minute. Requests over the limit receive HTTP 429 with `Retry-After: 60`.

- The limit is applied only after authentication and same-origin checks.
- Selecting the default provider and reading model configuration are not rate-limited by this limiter.
- The bound helps prevent accidental repeated calls to paid provider APIs.
- Automated integration tests use an unused loopback port and never call an external provider.

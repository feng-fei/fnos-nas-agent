# Phase 62 — Model adapter retry resilience

The OpenAI-compatible adapter now honors a provider's `Retry-After` response header when retrying retryable HTTP errors such as 429 and 5xx.

- Numeric seconds and HTTP-date values are supported.
- Provider hints are clamped to a maximum of 2 seconds, preserving the Agent's bounded retry budget.
- Missing or invalid headers fall back to the configured bounded retry delay.
- Retry counts, sanitized error categories and provider metrics remain intact.
- Provider response bodies and credentials are not surfaced in error messages.

Tests use a fake provider; no external model endpoint or NAS is contacted.

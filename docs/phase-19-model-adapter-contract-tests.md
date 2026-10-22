# Phase 19: Model Adapter Contract Tests

## Scope

Use a mocked fetch implementation to test the optional model adapter without network access or API credentials. Cover explicit opt-in and HTTPS endpoint validation, secret-safe status, request shape, provider errors, malformed/oversized responses, tool-call limits, and rejection of non-empty tool arguments.

## Safety

No real model provider is contacted. The adapter cannot run shell commands, and all proposed tool arguments must remain empty objects. The model output is untrusted and still passes through the Agent's allowlisted read-only tool registry.

## Acceptance

Run with Node.js 26.x. This is contract coverage, not proof of a third-party provider's availability or a license to enable write operations.

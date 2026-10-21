# Phase 17: HTTP Authentication Contract Tests

## Scope

Run the actual HTTP server as a child process against a temporary data directory and an ephemeral loopback port. Exercise first-run setup, rejection of state-changing requests without Origin, unauthenticated API denial, password login, cookie-authenticated read-only tool listing, cross-origin mutation rejection, and logout invalidation.

## Safety

- The server binds only to 127.0.0.1 during tests.
- Test data is isolated under a unique OS temporary directory and removed on teardown.
- The suite does not invoke NAS writes, shell commands, Skills, or remote model APIs.
- No production NAS or persistent user data is accessed.

## Acceptance

The test must pass under Node.js 24 and 26. A separate fnOS staging device is still needed for platform-specific FPK lifecycle checks.

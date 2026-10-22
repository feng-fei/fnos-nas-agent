# Phase 14: Authentication and Resource-Boundary Hardening

## Scope

- Replace the unbounded authentication-attempt map with a fixed-window limiter that expires stale keys and caps memory usage.
- Bound in-memory and restored sessions to 1,000 entries.
- Preserve generic authentication errors and existing same-origin checks.
- Add the `Secure` cookie attribute when the request is actually received over HTTPS, without pretending plain HTTP is encrypted.
- Add deterministic tests for throttling, expiry, reset after successful authentication, and key-cap behavior.

## Safety

The service still recommends trusted-LAN-only use while HTTP is configured. A Secure cookie flag is applied only when TLS terminates directly at this server; deployments behind a reverse proxy must not trust arbitrary forwarded headers. This phase does not enable remote shell or write operations.

## Validation

CI must run the Node.js 26.x test suite, syntax-check the server and limiter, validate the embedded UI script, and build/inspect the Node.js 26 FPK artifact.

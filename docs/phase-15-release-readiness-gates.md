# Phase 15: Release Readiness Gates

## Purpose

Create a deterministic pre-release gate that can run on Node.js 24 and 26 without third-party dependencies. It verifies that the release workflow still tests both runtime lines and inspects the Node.js 26 FPK artifact, and checks key safety boundaries across the server, Skill archive pipeline, manifest review, mobile UI, and permission policy.

## Release checklist

- [ ] Node.js 24 test job passes.
- [ ] Node.js 26 test job passes.
- [ ] Node.js 26 FPK build and package inspection pass.
- [ ] Archive and manifest size limits remain in force.
- [ ] Write/destructive operations remain denied by default.
- [ ] Approval ledger remains disconnected from execution until a separately reviewed server-side execution design exists.
- [ ] FPK is tested on a disposable fnOS test instance for install, start, stop, upgrade and uninstall.
- [ ] LAN/TLS/authentication behavior is validated before any real NAS installation.

## Explicitly not certified by CI

A successful build does not prove compatibility with every fnOS version or hardware. It does not replace a test installation, security review, backup, or operator authorization. This repository workflow must not deploy to the production NAS.

## Validation

`npm run check:release` runs on both Node.js 24 and 26 alongside the existing unit suite. The CI job still builds and inspects an FPK only on Node.js 26.

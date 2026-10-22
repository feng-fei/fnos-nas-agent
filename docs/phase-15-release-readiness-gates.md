# Phase 15: Release Readiness Gates

## Purpose

Create a deterministic pre-release gate that can run on Node.js 26.x without third-party dependencies. It verifies that the release workflow still tests the supported runtime line and inspects the Node.js 26 FPK artifact, and checks key safety boundaries across the server, Skill archive pipeline, manifest review, mobile UI, and permission policy.

## Release checklist

- [ ] Node.js 26 test suite and release safety checks pass.
- [ ] Node.js 26 FPK build and package inspection pass.
- [ ] The artifact SHA-256 sidecar and unsigned release manifest verify against the same FPK.
- [ ] Archive and manifest size limits remain in force.
- [ ] Write/destructive operations remain denied by default.
- [ ] Approval ledger remains disconnected from execution until a separately reviewed server-side execution design exists.
- [ ] FPK is tested on a disposable fnOS test instance for install, start, stop, upgrade and uninstall.
- [ ] LAN/TLS/authentication behavior is validated before any real NAS installation.

## Explicitly not certified by CI

A successful build does not prove compatibility with every fnOS version or hardware. It does not replace a test installation, security review, backup, or operator authorization. This repository workflow must not deploy to the production NAS.

## Validation

`npm test` and `npm run check:release` run on Node.js 26.x. The same job builds and inspects the x86 test FPK, writes its checksum and unsigned manifest, and verifies their consistency.

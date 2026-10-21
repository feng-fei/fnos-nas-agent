# Native FPK packaging draft

This directory is a draft native fnOS application template, not yet a build-verified FPK.

## Current boundaries

- Intended for x86 fnOS devices, including the target J4125 NAS.
- The app exposes a status-only web page and health endpoint.
- It does not execute shell commands on behalf of the model, inspect NAS data, or call fnOS administrative APIs.
- The lifecycle script expects a bundled Node.js executable at `app/bin/node`. That runtime is not committed in this repository yet.
- Desktop icon assets are also placeholders and must be supplied before a complete package can be built.
- Do not attempt to install this draft until the bundled runtime, icons, and manifest are validated.

## Build plan

1. Install the official `fnpack` CLI on a development machine.
2. Add a verified, pinned official Node.js Linux x64 runtime under `app/bin/node` (do not install Node.js onto the NAS during FPK installation).
3. Add valid fnOS desktop icon assets.
4. Validate all lifecycle scripts and the manifest against current official fnOS documentation.
5. Run `fnpack build` from this directory.
6. Install the resulting FPK manually on a test fnOS device and validate install/start/status/stop/uninstall.

## Runtime security note

The first FPK draft binds to the NAS interface so a phone on the LAN can reach it. Before enabling LAN use, add a real authentication flow and verify it end-to-end. Do not expose the service to the public internet.

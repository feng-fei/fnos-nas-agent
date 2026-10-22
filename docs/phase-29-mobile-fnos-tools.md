# Phase 29 — Mobile fnOS Read-only Tool Usability

## Delivered

- Render each tool's input controls from its published JSON schema.
- Mark required fields, apply string length and integer min/max constraints, and submit typed arguments.
- Keep tools with no parameters as one-tap read-only queries.
- Show whether the optional official `trim-cli` is connected, configured but unavailable, or not configured.
- Disable a tool's submit button while its request is in flight and show server responses in the existing result panel.

## Boundaries

- The UI does not configure an executable path, run OAuth, or store CLI credentials.
- It does not add write commands or relax the adapter allowlist.
- CLI integration is only usable after an administrator has configured a trusted official executable and completed its interactive authorization flow.
- CI and browser-script syntax checks do not replace validation on a non-production fnOS test device.

## Acceptance

- The Node.js 26.x test suite passes.
- Release gates and FPK packaging pass.
- Schema-backed `path` and `volumeId` inputs can be submitted with correct types.
- No-argument tools remain one-tap.

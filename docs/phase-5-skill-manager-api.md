# Phase 5: Skill inventory and review lifecycle

## Included in this phase

- Authenticated `GET /api/skills` with pagination and optional lifecycle-state filtering.
- Authenticated `POST /api/skills` to register a Skill's metadata and expected archive SHA-256.
- Authenticated `POST /api/skills/:id/transition` with server-side state-transition validation.
- Atomic JSON metadata persistence under the private app data directory, mode 0600.
- Mobile UI to register metadata, view inventory, and review allowed state transitions.
- Metadata-only responses; no Skill payload is returned by the API.

## Lifecycle

`pending_review -> approved | rejected`

`approved -> enabled | disabled | rejected`

`enabled -> disabled`

`disabled -> approved | rejected`

`rejected` is terminal. Invalid transitions return HTTP 409. The `enabled` state is only inventory state and does not permit execution; the tool registry remains empty and execution remains disabled.

## Current limitation

This is the inventory/review API, not ZIP import. The form accepts an archive SHA-256 supplied by the operator but does not upload, verify, extract, or store the archive. Do not mark a hash as verified unless it was calculated independently from the exact file. ZIP quarantine/import is a separate follow-on implementation and must validate archive structure and path traversal before any extraction. No package manager or imported code is executed.

## Security

All endpoints require a valid session. Mutations also verify the request Origin and JSON content type. Records are bounded to 500 entries; names, versions, notes, and declared capabilities are length-limited. Persistent metadata is written by atomic replacement with restrictive permissions. The UI uses text nodes for imported metadata, not HTML interpolation.

The service still uses HTTP; keep it on a trusted LAN and do not port-forward it. This phase does not enable shell, Docker, system service, model, or Skill execution.

## Release gate

Run the complete Node.js 26.x test suite, then build the FPK artifact. Verify authentication, persistence, invalid transitions, UI behavior, and that the tool registry remains empty before merging. No production NAS changes were made by this PR.

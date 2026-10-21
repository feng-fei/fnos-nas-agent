# Phase 3 — Skill Manager Contract

## Scope

This phase adds a reviewable Skill inventory and lifecycle. It does not execute imported Skill code, install dependencies, invoke shell scripts, or grant NAS privileges. Node.js 26.x is the packaged runtime; use the latest available patch in the 26.x line. Node.js 24.x remains a CI regression line only.

## Security prerequisite

The packaged FPK currently binds to all interfaces without client authentication. Therefore, **do not expose Skill-management routes or import endpoints until authentication and authorization are implemented and tested**. A hidden UI control is not an access control. Every management API must independently authenticate the request.

## Lifecycle states

- `pending_review`: imported metadata and files are quarantined; not available for dispatch.
- `approved`: a reviewer accepted the package contents and requested capabilities; still not executable.
- `enabled`: eligible for future dispatch only after a separate built-in adapter and policy allowlist exist. This state never means arbitrary package code may run.
- `disabled`: excluded from dispatch immediately.
- `rejected`: retained as minimal audit metadata; package payload may be removed only through an explicit cleanup action.

Allowed transitions:

- `pending_review -> approved | rejected`
- `approved -> enabled | disabled | rejected`
- `enabled -> disabled`
- `disabled -> approved | rejected`
- `rejected` is terminal unless a new import creates a new Skill record.

Every transition must be validated server-side and written atomically. Unknown states and transitions fail closed.

## Import boundary

The first import implementation must accept a ZIP upload only after authentication, enforce request and archive size limits, and store it in a private quarantine directory outside the executable app payload. It must not extract files directly into a live Skill directory.

Archive validation requirements:

- Reject absolute paths, drive-letter paths, NUL bytes, `..` traversal, duplicate normalized paths, symlinks, and unsupported special files.
- Reject archives exceeding configured compressed size, uncompressed size, entry count, or per-file size limits.
- Normalize path separators and validate every path before writing any file.
- Treat metadata as untrusted data; do not load or evaluate JavaScript, shell, lifecycle hooks, or package scripts.
- Calculate SHA-256 for the archive and each accepted file.
- Do not run `npm install`, `pip install`, or any package manager during import or review.

Because Node.js does not provide a high-level ZIP archive API, the implementation must choose one of two reviewed approaches before coding: a small, audited pure-JavaScript parser with adversarial tests, or a fixed system extractor invoked with a fixed argument array in a controlled temporary directory and followed by strict filesystem validation. Do not use model-controlled command strings or `shell: true`.

## Record schema

Each Skill record should contain only operational metadata:

- generated opaque ID;
- display name and declared version;
- import timestamp;
- source label supplied by the user (not trusted as provenance);
- archive SHA-256 and per-file hashes;
- lifecycle state;
- declared capabilities;
- reviewer decision timestamp and reviewer label;
- bounded validation findings.

Do not store secrets, full file contents, API tokens, or arbitrary execution output in the index. The package payload remains quarantined and access-controlled.

## API contract (after authentication exists)

- `GET /api/skills`: return paginated metadata only; never include payload contents.
- `POST /api/skills/import`: accept a bounded archive and return its new ID, state, hash, and validation summary.
- `GET /api/skills/:id`: return metadata and findings, not file contents by default.
- `POST /api/skills/:id/transition`: accept only a named target state and a bounded review note; validate transition server-side.
- `DELETE /api/skills/:id/payload`: optional later cleanup endpoint; require a separate explicit confirmation and retain minimal audit metadata.

All endpoints must use authentication and authorization, strict method/content-type checks, request timeouts, and bounded body sizes. Responses must not disclose filesystem paths or secrets.

## Tests and release gates

Required automated tests:

- valid archive inventory and stable SHA-256;
- path traversal, absolute path, duplicate path, symlink, malformed ZIP, and oversized archive rejection;
- no file written outside quarantine after any invalid archive;
- invalid lifecycle transitions rejected;
- disabled/rejected Skills cannot be dispatched;
- unauthenticated requests receive 401/403 and cannot change state;
- malformed requests and unknown Skill IDs fail closed;
- API output excludes absolute paths, payload contents, and secret-like values.

The phase is complete only when all tests pass on Node.js 26.x, the Node.js 24.x regression tests remain green where supported, and a test FPK passes lifecycle validation on a non-production fnOS test system. Do not install or modify the user's production NAS as part of CI.

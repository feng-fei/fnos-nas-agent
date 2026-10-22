# Phase 133 — Model fallback, scan bounds and one decision point

Phase 126 moved the execution decision into a single policy module. Phase 133 removes
the remaining places where a second, weaker decision was made, and repairs the two
availability bugs the audit found behind it.

## 1. A backup provider is actually reachable

The adapter used to try a backup provider only when the primary failure was
"retryable" (408, 425, 429 and 5xx). A provider that answers `401` (wrong key),
`403` (forbidden) or `404` (unknown model) was therefore treated as final: the
configured backups were never contacted, and the user saw a failure even though a
working provider was configured.

A provider that refuses the request is almost always specific to that provider, so
the adapter now moves on to the next candidate:

| Primary provider answer | Backup provider tried? |
| --- | --- |
| `400`, `422` (the request itself is malformed) | no |
| `401`, `403` (key or permission) | yes |
| `404` (the model does not exist there) | yes |
| `408`, `425`, `429`, `5xx` | yes |
| network error or timeout | yes |
| malformed structured output (`MODEL_INVALID_PLAN`) | no |

A malformed request is deliberately not repeated: the same body would fail against
every provider, and retrying it would only multiply the request count.

## 2. The upstream status survives the adapter

`model-adapter.mjs` rebuilt the error object when it gave up and dropped the
`statusCode` in the process, so the caller could not tell a wrong key from an
unreachable host. The status code is now carried through both error paths, and
`agent-core.mjs` uses it to tell the operator what to check — without ever echoing
an upstream message, endpoint or key:

| Upstream status | Message shown to the user |
| --- | --- |
| `401`, `403` | the model service refused the request (authentication failed) |
| `404` | the model service does not know the configured model |
| `429` | the model service is rate limiting |
| `5xx` | the model service is temporarily unavailable |
| `MODEL_INVALID_RESPONSE` | the answer did not follow the agreed format |

The error itself is logged as code plus status only, so no provider detail reaches
the log file either.

## 3. A directory listing is bounded

`file-browser.mjs` read a whole directory into memory and then stat-ed every entry,
even though only a page of at most 200 entries is ever returned. A directory with
hundreds of thousands of entries could therefore stall the request.

The listing now reads at most 2000 entries per directory through a directory handle
(the same pinned descriptor that the confinement work introduced) and reports
`truncated: true` when the directory holds more. The recursive search uses the same
bound on top of its existing 5000-visit budget.

## 4. One decision point for the permission policy

`permission-policy.mjs` was dead code: no module imported it, and only the release
gates and its own test file referred to it. It is now a thin adapter over the global
execution policy, so there is exactly one place where "may this run?" is answered.

The legacy shape is unchanged — `createPermissionPolicy(overrides)` still returns
`evaluate({ risk, approved })` and `snapshot()`, the legacy flags still work, and the
legacy reason vocabulary (`read-only-allowed`, `write-allowed`,
`explicit-approval-required`, `policy-denied`, `unknown-risk`) is preserved — so the
existing callers, the existing test and the release gates keep their expectations
while the verdict itself is made by the execution policy.

## 5. Tests

`tests/phase-133-model-fallback-and-scan-bounds.test.mjs` covers the reachable
backup provider, the request that is not repeated, the preserved status code, the
delegating permission policy and the bounded directory scan. The scan test needs the
Linux directory descriptor confinement and is skipped elsewhere.

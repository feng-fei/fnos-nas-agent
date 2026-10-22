# Phase 134 — Overview Service

The mobile-first console opens on a single overview page. Filling that page
used to mean six parallel requests — health, diagnostics, execution mode, task
status, skills and models — and every one of them had to succeed before the
page looked complete. This phase adds one aggregation service and one
endpoint that returns every headline number in a single response.

## The service

`apps/fnos-nas-agent/app/overview.mjs` exports:

```js
createOverviewService({ health, executionPolicy, taskManager, skillStore,
                        modelProviderStore, actionApprovals, agentCore, now })
  → { snapshot() }
```

`snapshot()` is synchronous, never throws, and always returns the same shape.
Every dependency is optional and every upstream call is defensive: a missing
service, a missing method, or a method that throws falls back to a safe
default instead of breaking the page.

The snapshot carries counters and identifiers only. No API key, no token, no
secret and no absolute path is ever copied into it, so the endpoint can be
rendered without a second round of redaction.

## The shape

| Field | Meaning |
| --- | --- |
| `generatedAt` | ISO timestamp of the snapshot |
| `app.name`, `app.version` | Application identity and version |
| `health.ok`, `health.degraded` | Service health and the degraded flag |
| `health.degradedComponents` | Which subsystem is degraded, e.g. `skills` |
| `execution.mode`, `execution.source` | Current execution mode and where it came from |
| `execution.modes` | The three selectable modes |
| `tasks.queued`, `tasks.running`, `tasks.retained`, `tasks.concurrency` | Task queue counters |
| `skills.total`, `skills.pendingReview`, `skills.enabled` | Skill inventory counters |
| `models.providerCount`, `models.activeProviderId`, `models.enabled` | Model provider counters |
| `approvals.pending` | Number of destructive actions waiting for a decision |
| `agent.rulesFirst`, `agent.availableTools`, `agent.modelEnabled` | Agent readiness |

## The endpoint

`GET /api/overview` requires an authenticated session, like every other
dashboard endpoint, and answers with the snapshot as JSON. A failing
aggregation is reported as a plain `500` instead of a half-filled page.

The endpoint reuses the same `healthSnapshot()` helper as `GET /api/health`,
so the two can never disagree about the service state.

## Coverage

`tests/phase-134-overview-service.test.mjs` covers the shape, the fallbacks for
missing and throwing dependencies, the secret-free guarantee and the
degraded-component reporting.

## Why it matters

Before this phase the overview page had to assemble itself from six
independent responses, each with its own failure mode. One slow endpoint made
the page look broken. Now the page has a single source of truth, one request
and one consistent snapshot.

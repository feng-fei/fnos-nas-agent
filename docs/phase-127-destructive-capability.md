# Phase 127 — Destructive capability tokens and approval binding

## 1. The problem

Until Phase 127 the "confirmation" for a destructive file operation was a
boolean in the request body:

```js
// apps/fnos-nas-agent/app/file-manager.mjs (before)
if (input.confirm !== true) fail(400, "Explicit confirmation is required");
```

and the HTTP layer forwarded the client's JSON straight into the file manager:

```js
// apps/fnos-nas-agent/app/server.mjs:412 (before)
return reply(res, 200, await fileManager.operate(await jsonBody(req)));
```

A boolean that the caller itself supplies proves nothing. It only shows that
the caller knows a field name — it is not an authorization decision, it is not
bound to a user session, it is not bound to a task, and it can be replayed.
Any client that can reach the endpoint could therefore delete data while
claiming to have "confirmed" it, which directly contradicts the repository's
own promise to *"fail closed: … expired approval, missing auth, or policy
uncertainty means no execution"* (`docs/security.md:72`).

## 2. The replacement: a module-private capability

`apps/fnos-nas-agent/app/execution-capability.mjs` exports a single
module-private symbol:

```js
export const DELETE_CAPABILITY = Symbol("fnos-nas-agent.delete-capability");
export function hasDeleteCapability(value) { return value === DELETE_CAPABILITY; }
```

Properties that matter:

* **Not constructible from the outside.** The symbol is created with `Symbol()`
  (not `Symbol.for()`), so it has no global registry key. Another module — or
  a JSON request body, a query string, a header — cannot recreate it.
* **Not serialisable.** `JSON.stringify` drops symbols, so the capability
  cannot be leaked into a request or a response body by accident.
* **Not forgeable.** A caller can send any string, number or object as
  `capability`; `hasDeleteCapability()` compares by identity, so only the
  in-process value passes.

## 3. Where the capability is required

### 3.1 File manager

`apps/fnos-nas-agent/app/file-manager.mjs` — the `delete` branch of
`operate()` now requires the capability:

```js
if (!hasDeleteCapability(input.capability)) {
  fail(403, "Explicit confirmation is required: destructive deletion must be authorized by the server");
}
```

The message keeps the literal substring `Explicit confirmation is required`
because `scripts/check-release-gates.mjs:233` asserts on it. The status code
changed from `400` to `403`: a missing authorization is a refusal, not a
malformed request.

`operateBatch()` performs the same check **before** executing anything: if any
entry of the batch is a `delete` without a capability, the whole batch is
rejected with 403 and not a single operation runs. A batch is therefore never
"partially authorised".

### 3.2 Tool registry

`apps/fnos-nas-agent/app/read-only-tools.mjs` — `invoke(id, args, options)`
gained a third parameter. `options.capability` is what a caller of the
registry hands over; the registry itself never accepts a client-supplied
boolean any more:

```js
const approved = hasDeleteCapability(options.capability);
if (executionPolicy) {
  const verdict = executionPolicy.evaluate({ risk: tool.risk, approved });
  if (!verdict.allowed) { /* throw with verdict.statusCode and verdict.reason */ }
}
if (tool.risk === "destructive" && !approved) { /* 403 missing-capability */ }
```

The `files.delete` branch now forwards the capability instead of hard-coding a
confirmation:

```js
return fileManager.operate({ action: "delete", path: args.path, capability: DELETE_CAPABILITY });
```

## 4. The approval chain

```
HTTP request                       server.mjs (Lead's wiring)
     │
     ├─ agent-core.run(input, { sessionId })
     │        └─ executePlan → destructive call
     │             └─ actionApprovals.request({ toolId, args, taskId, sessionId })
     │                  └─ approval-ledger.issue(...) → pending item carries
     │                     taskId, toolId, risk, actionHash (digest of the
     │                     canonicalised arguments), expiry and sessionId
     │
     ├─ GET  /api/actions/pending        → only the caller's own pending items
     └─ POST /api/actions/confirm        → action-approval-service.confirm(id, sessionId)
              ├─ ownership check: item.sessionId must match → else 403
              │     "The pending action belongs to another session"
              │     (the one-time token is NOT consumed)
              ├─ ledger.consume(...) → token is deleted, one-shot
              └─ tools.invoke(item.toolId, item.args, { capability: DELETE_CAPABILITY })
```

Binding properties that now hold (see `docs/security.md:33-40`):

| Required binding | Where it is implemented |
| --- | --- |
| a concrete task | `approval-ledger.mjs:60-63` stores `taskId`; `consume()` compares it |
| a concrete tool call | `approval-ledger.mjs:60-63` stores `toolId`; `consume()` compares it |
| the exact arguments | `actionHash` = digest of the canonicalised `{ toolId, args }` |
| the current user session | `sessionId` on the pending item, checked in `confirm()` before the token is consumed |
| short expiry | `approval-ledger.mjs:42` TTL between 1 s and 5 min |
| single execution | `approval-ledger.mjs:78` deletes the pending entry on consume |

`action-approval-service.mjs` keeps the previous order — *consume first, then
execute* — so a crash between the two leaves the token spent, not reusable.
The ownership check happens **before** the consume, so a foreign session cannot
burn another session's approval either.

## 5. HTTP behaviour expected from the server layer

The server is the only place that can mint the capability, so the wire
protocol is unchanged for the client except for one detail:

* A destructive call that has **not** been approved must be answered with
  **202 Accepted** and an `approvalId` (the pending approval id), so the UI can
  render the confirmation dialog. The server then:
  * `GET  /api/actions/pending` → the pending items of the current session;
  * `POST /api/actions/confirm` with `{ "id": "<approvalId>" }` → the server
    consumes the one-time token and invokes the tool **with the capability**.
* A destructive call that is already approved never exposes the capability to
  the client. The client only ever sees an id; the id is useless without the
  session that created it.
* The direct file endpoint (`POST /api/files/operation`) must no longer be
  able to delete anything: `fileManager.operate()` rejects a missing
  capability with 403. The HTTP layer should stop translating the client's
  `confirm: true` into an approval — the approval service is the only
  producer of the capability.

> Note for the server wiring: `read-only-tools.mjs` is constructed by
> `server.mjs` with `createReadOnlyToolRegistry({ ... })`. Passing the policy
> instance (`executionPolicy`) into that factory is what makes the read-only
> mode and the kill switch effective on the HTTP path as well.

## 6. Error mapping

| Situation | Status | `reason` |
| --- | --- | --- |
| destructive call without approval | 403 | `missing-capability` |
| destructive call without approval, policy consulted | 403 | `approval-required` |
| write call while in `read-only` mode | 403 | `read-only-mode` |
| any call while in `halted` mode | 503 | `kill-switch` |
| unknown or missing risk level | 403 | `unknown-risk` |
| delete without capability at the file manager | 403 | message contains `Explicit confirmation is required` |
| approval confirmed by a foreign session | 403 | message `The pending action belongs to another session` |

## 7. Tests

`tests/phase-127-destructive-capability.test.mjs` proves that

* the capability cannot be reconstructed from a string, a `Symbol.for()` twin or
  a plain object;
* `fileManager.operate({ action: "delete", path })` and
  `fileManager.operate({ action: "delete", path, confirm: true })` are both
  refused with 403;
* a batch that contains an unauthorised delete is refused as a whole;
* the registry refuses `files.delete` without a capability and forwards the
  capability (and no `confirm` flag) when it has one;
* `read-only` mode refuses write tools and refuses a destructive call even
  with a capability, while read-only tools keep working;
* `halted` mode refuses every call with 503.

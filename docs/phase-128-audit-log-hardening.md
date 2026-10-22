# Phase 128 — Audit log hardening

## 1. The problem

The audit logger was the last thing in the request path that could still kill the
process. Events are recorded from a response `"finish"` listener, which runs *after*
the request handler returned and therefore outside the `try/catch` that guards the
handler:

```js
// apps/fnos-nas-agent/app/server.mjs (before)
if (auditLogger && auditRouteName) res.once("finish", () => {
  void auditLogger.record({ method: req.method, route: auditRouteName, statusCode: res.statusCode });
});
```

`record()` validated its input by throwing:

```js
// apps/fnos-nas-agent/app/audit-log.mjs (before)
if (!METHODS.has(method)) throw new TypeError("Invalid audit method");
if (!ROUTES.has(route)) throw new TypeError("Invalid audit route");
if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) throw new TypeError("Invalid audit status");
```

The route allowlist did not contain the route name that the server actually produced
for the checksum endpoint:

```js
// apps/fnos-nas-agent/app/server.mjs (before)
if (pathname === "/api/files/checksum") return "files.checksum";
```

Any client — including an unauthenticated one, because the audit hook is attached to
the response and not to the authorization decision — could therefore trigger an
uncaught `TypeError` inside a `finish` callback. Nothing in the service caught it:
there was no `uncaughtException` handler, so the Node process exited and the NAS lost
every in-flight task, session and upload with it.

Two smaller problems sat next to it:

* a write failure was swallowed by `.catch(() => {})`, so a full or read-only data
  directory produced a silently missing audit trail;
* the event carried no session or tool context, so an operator could not tell which
  session performed an action.

## 2. The replacement: normalization instead of rejection

`apps/fnos-nas-agent/app/audit-log.mjs` no longer throws for any input. Unknown or
malformed metadata is normalized to a safe value:

```js
const FALLBACK_ROUTE = "other_api";
const FALLBACK_METHOD = "UNKNOWN";
const FALLBACK_STATUS_CODE = 500;

function normalizeEvent(event, now) {
  const method = typeof event?.method === "string" ? event.method.toUpperCase() : "";
  const route = typeof event?.route === "string" ? event.route : "";
  const statusCode = event?.statusCode;
  const safeMethod = METHODS.has(method) ? method : FALLBACK_METHOD;
  const safeRoute = ROUTES.has(route) ? route : FALLBACK_ROUTE;
  const safeStatusCode = Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
    ? statusCode
    : FALLBACK_STATUS_CODE;
  ...
}
```

The allowlist gained the two route names the server can actually emit:

```js
const ROUTES = new Set([
  "setup", "login", ..., "files.manage", "files.checksum", ...,
  "models.test", "execution.mode", "other_api"
]);
```

`record()` also became failure-isolated in both directions. Serialization errors and
write errors are reported instead of being thrown or swallowed:

```js
record(event) {
  let line;
  try {
    line = JSON.stringify(normalizeEvent(event, now)) + "\n";
  } catch (error) {
    console.error(`[audit] Could not serialize audit event: ${error?.message || "unknown error"}`);
    return Promise.resolve();
  }
  queue = queue.then(() => writeEvent(line)).catch(error => {
    console.error(`[audit] Could not append audit event to ${file}: ${error?.message || "unknown error"}`);
  });
  return queue;
}
```

The JSONL contract is unchanged: one JSON object per line, the same `at`, `method`,
`route`, `statusCode` and `outcome` fields, the same single-generation rotation and
the same `filePath()` / `flush()` interface. A constructor with an unsafe filename
still throws, because that is a programming error rather than runtime input.

## 3. The optional metadata

An event may now carry a small, explicitly allowlisted set of context fields:

```js
const OPTIONAL_FIELDS = Object.freeze(["sessionId", "toolId", "target", "risk", "requestId"]);
const MAX_OPTIONAL_LENGTH = 256;
```

A field is only written when it is a non-empty string of at most 256 characters with
no control characters; everything else is dropped. The fields are omitted entirely
when they are absent, so an event without context still has exactly the five
original keys.

## 4. What the tests cover

`tests/phase-128-audit-log-hardening.test.mjs` adds:

* the checksum and execution-mode routes are recorded verbatim, not normalized away;
* hostile payloads (`undefined`, `null`, non-string method/route, non-integer status
  code, oversized metadata) never throw and always produce a well-formed line;
* unusable optional metadata is dropped instead of persisted;
* a failing write is reported on the console and does not break the audit chain;
* the JSONL layout and the single-generation rotation still hold under load.

`tests/phase-20-audit-log.test.mjs` was updated in the same pass: the previous
expectation that an unknown route makes `record()` throw was replaced by the
normalization contract, and the session/tool metadata is asserted on disk.

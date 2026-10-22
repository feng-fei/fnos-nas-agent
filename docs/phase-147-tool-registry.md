# Phase 147 — Registrable tool registry

## 1. The problem

Until this phase the tool catalogue of the Agent was a hard coded list inside
one module (`apps/fnos-nas-agent/app/read-only-tools.mjs`). That list was
correct for the built-in fnOS tools, but it made three things impossible:

* a **Skill** that ships its own tool could not publish it into the same
  catalogue, so the model could never call it;
* an **MCP server** (Phase 148) had nowhere to register the tools it
  publishes;
* the UI and the audit log could not tell **where a tool came from**, so a
  foreign tool was indistinguishable from a built-in one.

## 2. What this phase adds

`apps/fnos-nas-agent/app/tool-registry.mjs` turns the catalogue into a
registry of *sources*:

```js
import { createToolRegistry } from "./tool-registry.mjs";

const registry = createToolRegistry({ sources, executionPolicy, tracer });
registry.list();          // [{ id, title, description, risk, inputSchema, source }]
registry.get(id);         // one tool or null
registry.addSource(source);   // register a new source at runtime
registry.removeSource(id);     // unregister it again
registry.sources();            // [{ id, kind, toolCount, status }]
```

Every source is tagged with one of `TOOL_SOURCE_KINDS`:

```js
export const TOOL_SOURCE_KINDS = Object.freeze(["builtin", "skill", "mcp"]);
```

## 3. The rules the registry keeps

* **The built-in source keeps its own gate.** The `builtin` source is the
  existing `read-only-tools.mjs` registry, with its own execution policy and
  its own error messages. The registry does not re-implement it, so the
  behaviour of the built-in tools is byte for byte the behaviour of the
  previous release.
* **A foreign source never bypasses the global execution policy.** A tool of a
  Skill or an MCP server is evaluated by the same `executionPolicy` before it
  runs. A tool whose risk is not one of `read-only`, `write`, `destructive` is
  refused, it is never treated as harmless.
* **Destructive tools stay destructive.** The risk of a foreign tool is the
  risk that its source declared. A server that does not declare a risk is
  treated as `write` at the latest, never as `read-only`.
* **The identifier is normalised.** `normalizeToolId()` accepts a limited
  character set and a bounded length, so a hostile server cannot inject an
  identifier that collides with a built-in one or that breaks the audit log.
* **The arguments are validated against the declared schema.** A foreign tool
  that publishes no schema cannot be invoked: `validateToolArgs()` refuses a
  call with arguments it cannot describe.

## 4. Observability

The registry can be attached to the tool tracer of Phase 146. Every invocation
is traced with the identity of its source, so the trace answers *which tool of
which server ran*. The trace stores sizes, timings and a fingerprint only, it
never stores the arguments or the result of the call.

## 5. Known limits

* The registry is a runtime catalogue. It is not a persistence layer: a
  source is registered when the process starts and it is gone when the process
  stops.
* A Skill that publishes tools is a planned feature. The registry already
  accepts a `skill` source, but the importer that creates one from a Skill
  package is not part of this phase.

## 6. Files

| File | Role |
| --- | --- |
| `apps/fnos-nas-agent/app/tool-registry.mjs` | The registry itself. |
| `tests/phase-147-tool-registry.test.mjs` | Behaviour and safety rules. |
| `apps/fnos-nas-agent/app/server.mjs` | Wires the built-in and the MCP source into one registry. |

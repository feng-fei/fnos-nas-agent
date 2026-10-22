# Phase 7: Read-only tool registry

## Purpose

Expose a small, explicit allowlist of built-in read-only tools for agent planning and mobile operation. This is a structured API layer, not a general command runner.

## Built-in tools

- `system.status`: OS/runtime identity, uptime, CPU/load and memory summary.
- `storage.summary`: capacity summary for the root filesystem and configured application data filesystem.
- `network.interfaces`: non-internal network interfaces and their IP/CIDR addresses.

All tools currently accept an empty argument object. Input schemas set `additionalProperties: false`; any supplied argument is rejected. Unknown tool IDs return 404.

## API

- `GET /api/tools`: requires an authenticated session and returns the tool catalogue, schemas, and safety labels.
- `POST /api/tools/<tool-id>/run`: requires an authenticated session, same-origin request, JSON body, and a registered tool ID. Use `{}` as the request body.

The response keeps `executionEnabled: false` to make clear that arbitrary command/Skill execution remains disabled, while `readOnlyExecutionEnabled: true` indicates that the small built-in read-only allowlist is available.

## Security boundary

- No shell, child process, Docker socket, service control, file writes, dynamic import, Skill execution, or model call.
- Tool handlers read the existing bounded diagnostics snapshot and return only the fields relevant to that tool.
- The registry is code-defined and fail-closed; it does not load tool definitions from uploaded Skills or writable configuration.
- API calls require session authentication. Invocation additionally checks the request Origin.
- The mobile UI uses DOM text nodes for returned data and provides a button per allowlisted tool.

## Validation

CI must pass the Node.js 26.x test suite and the Node 26 FPK package inspection. Tests cover catalogue allowlisting, scoped results, invalid arguments, unknown IDs, unauthenticated access, and cross-origin rejection.

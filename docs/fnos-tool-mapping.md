# fnOS Official Skill Tool Mapping

## Source of truth

The supplied official fnOS Skill ZIP is the reference for task instructions and `trim-cli` usage. This document is a design mapping, not a claim that each command has already been validated against a live NAS.

Before implementing a command, confirm its exact syntax, output format, required authorization, platform compatibility, and read/write behavior in the relevant official Skill entry/reference file.

## Initial mapping

| Agent capability | Initial policy | Implementation note |
|---|---|---|
| System information | Read-only allowlist candidate | Validate exact command and redact output |
| CPU/resource monitoring | Read-only allowlist candidate | Bound time range and response size |
| Storage/pool status | Read-only allowlist candidate | Avoid exposing unnecessary path/user details |
| File listing/summary | Read-only allowlist candidate | Restrict path scope; never accept arbitrary paths without validation |
| Application list/details | Read-only allowlist candidate | No install/remove in first release |
| Docker container list/details | Read-only allowlist candidate | No arbitrary Docker arguments |
| Selected logs | Read-only allowlist candidate | Redact credentials and cap bytes/lines |
| Network diagnostics | Read-only allowlist candidate | No network configuration changes |
| User information | Sensitive read-only candidate | Exclude secrets and minimize personal data |
| App install/remove | Denied in v0.1 | Requires separate policy and explicit confirmation |
| Container start/stop/restart | Disabled initially | Add only after confirmation flow and tests |
| File mutation/delete | Denied in v0.1 | Destructive; do not expose through general-purpose file tools |
| User/permission mutation | Denied in v0.1 | Privilege-sensitive |
| Storage/network/system mutation | Denied in v0.1 | High impact and potentially difficult to reverse |

## Adapter contract

The adapter should expose typed operations, for example:
- `fnos.system.info`
- `fnos.monitor.resources`
- `fnos.storage.status`
- `fnos.apps.list`
- `fnos.docker.containers.list`
- `fnos.logs.read`

These are internal Agent tool IDs, not claimed official `trim-cli` command names.

Each tool definition includes:
- input schema;
- risk tier;
- read/write classification;
- timeout;
- output byte limit;
- redaction rules;
- required authentication/authorization;
- confirmation policy;
- supported fnOS/CLI version range.

The model can request only these internal tool IDs. It cannot supply a raw command, executable path, shell snippet, or arbitrary CLI flag.

## CLI invocation requirements

- Resolve the approved binary path from trusted installation configuration.
- Verify the expected architecture and, where available, integrity/hash before use.
- Pass arguments as an array without a shell.
- Do not print environment variables or credentials.
- Capture stdout/stderr with strict byte limits and redact before persistence or display.
- Fail closed when the command is unsupported, authorization is missing, or output cannot be safely parsed.

## OAuth

The official package documents OAuth 2.0 Authorization Code + PKCE. The adapter must use the documented interactive authorization flow and only the scopes required by the selected read-only tools. Do not bypass consent or request broad scopes for convenience.

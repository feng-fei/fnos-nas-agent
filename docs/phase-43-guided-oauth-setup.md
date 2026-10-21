# Phase 43 — Guided official CLI OAuth setup

## Goal

Provide a practical first-login path for the official trim-cli integration without moving OAuth credentials or the one-time authorization code through the Agent web application.

## User flow

1. Import the official fnOS Skill ZIP into quarantine, review its manifest, approve it, install the matching Linux CLI binary, and enable the Skill.
2. Open NAS 智能助手 → 首次授权 / 连接配置指南. Enter the NAS host, port, protocol, and the applicable certificate/refresh options. Do not include a URL scheme, port, path, user name, or password in the host field.
3. Generate and copy the command. The authenticated same-origin API validates the target and builds a quoted shell command using the installed CLI's absolute path, the Agent service account, and the same private HOME / XDG_CONFIG_HOME used by Agent requests.
4. Open a trusted NAS terminal/SSH session and run the command there. The CLI prints its authorization URL. Open that URL in your own browser, sign in and consent, then paste the one-time code directly into the CLI's interactive terminal prompt.
5. Once the CLI reports successful login, return to Agent and run 检测官方 CLI 连接. This performs only the allowlisted, read-only system.info probe.

The Agent web application only generates the command; it does not start the login process, collect the authorization code, proxy the CLI prompt, or display/store OAuth tokens. Command generation is session-authenticated, same-origin protected, input-validated, and audited without logging submitted host details or command contents.

## Profile ownership and paths

The command uses sudo -u <Agent service account> -- env ... so the profile is not accidentally created under the interactive SSH user's home directory. It sets:

- HOME to the Agent private app data directory.
- XDG_CONFIG_HOME to the Agent data directory's .config directory.
- The home profile plus the supplied host, port and protocol.

Those values intentionally match the environment used for the Agent's later CLI calls. If sudo is unavailable in the NAS shell, switch to the same system account that runs the Agent and remove only the initial sudo -u … -- prefix. Do not save the profile as an unrelated account, or the Agent may not be able to read it. Treat the generated command as local configuration detail; do not post it in public issue reports.

## Protocol and certificate options

- HTTPS is recommended. Common defaults are port 5667 for a directly addressed NAS IP and port 443 for a domain, but the actual CLI/API configuration is authoritative.
- HTTP adds --allow-insecure-http explicitly and should only be considered on a trusted network.
- --tls-insecure is added only when the user explicitly checks the self-signed-certificate option, and only for HTTPS. Prefer a trusted certificate.
- The optional refresh flow adds the official CLI's login --refresh option; first-time setup should use the default interactive login.

## Recovery and limits

A connection test reports success only after the read-only system-information probe succeeds. A present executable alone does not prove OAuth authorization or API reachability. On failure, review the host/port/protocol, connectivity, profile ownership and whether authorization needs to be refreshed. Raw CLI stderr is suppressed because it may contain sensitive session details.

This phase does not execute generated shell commands on behalf of the user and does not support browser OAuth automation. CI validates the command builder, authentication/origin contract, UI script syntax, and unit tests on Node.js 26. It does not prove OAuth works against a real fnOS NAS; device acceptance remains a separate step.

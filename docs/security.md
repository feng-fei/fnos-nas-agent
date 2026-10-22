# Security Model

## Defaults

- Bind the web server to loopback by default during development. LAN binding must be an explicit deployment setting.
- Require authentication before exposing NAS information or actions.
- Use a per-install random secret or a supported fnOS authentication integration; never ship a default password.
- Do not expose the management UI directly to the public internet.
- Do not store NAS passwords in the Agent.
- Never log API keys, OAuth access/refresh tokens, cookies, authorization headers, or full secret-bearing command lines.
- Do not enable unrestricted root access as a convenience feature.

## Risk tiers

### Tier 0 — local deterministic operations

Examples: show Agent version, show enabled Skills, display task history metadata. No NAS mutation.

### Tier 1 — read-only NAS queries

Examples: system information, application list, container list, selected logs. Allow only after authentication, schema validation, and output redaction.

### Tier 2 — reversible service operations

Examples: start, stop, or restart a known service/container. Require a confirmation that names the target and exact action.

### Tier 3 — destructive or broad mutations

Examples: delete files, remove apps, modify network/storage/users, bulk changes, execute arbitrary scripts. Deny by default in v0.1. If ever added, require a separate explicit policy decision and strong confirmation.

## Approval requirements

A confirmation is bound to:
- the specific task and tool call;
- the exact validated arguments;
- the current user session;
- a short expiry;
- a single execution.

Any change to the arguments invalidates the approval. Replaying an approval must not execute the operation twice.

## Command execution

- Use a fixed executable path and `spawn`/equivalent with an argument array.
- Never use `shell: true` for model-controlled values.
- Validate tool names and every argument against a schema and allowlist.
- Set execution timeouts, output byte limits, and concurrency limits.
- Do not accept executable paths, environment overrides, or raw command strings from the model.
- Treat CLI output as untrusted data; it may contain secrets or terminal control sequences.

## Skill package safety

- Imported packages start in a quarantine/pending-review state.
- Parse metadata as data; never evaluate JavaScript, shell, or lifecycle hooks during import or review.
- Reject path traversal, symlinks escaping the package root, duplicate normalized paths, oversized files, and unexpected executable files.
- Record package origin, version, content hash, review status, and requested capabilities.
- Enabling a Skill does not grant it permissions.
- Only the built-in adapter may execute tools in v0.1; Skill instructions alone never create executable tools.
- Updates are staged and reviewed before replacing an enabled version.
- Disabling a Skill prevents new dispatches immediately.

## OAuth and secrets

The official fnOS Skill documentation describes an OAuth 2.0 Authorization Code + PKCE flow. The adapter must follow the exact supported flow and must not collect a NAS password or bypass interactive authorization. The exact token storage and refresh behavior must be confirmed against the supplied official package before implementation.

## Audit trail

Record timestamp, user/session identifier, Skill ID/version, tool name, risk tier, approval status, duration, and outcome. Redact arguments that may contain secrets or personal data. Do not store full file contents or unbounded raw logs by default.

## Incident controls

Provide a global read-only mode and a kill switch that blocks all mutating tool calls. A Skill can be disabled without stopping the core web UI. Errors fail closed: unknown tool, malformed arguments, expired approval, missing auth, or policy uncertainty means no execution.

Implemented in [Phase 126 — Execution Policy](phase-126-execution-policy.md), [Phase 127 — Destructive Capability](phase-127-destructive-capability.md), and [Phase 131 — Server hardening](phase-131-server-hardening.md):

- The execution policy has three modes: `normal`, `read-only` and `halted`. The mode comes from `<AGENT_DATA_DIR>/execution-mode.json` first, from `AGENT_EXECUTION_MODE` second, and from the default last.
- `read-only` refuses every write and destructive tool call; `halted` refuses every tool call and answers `503`.
- An operator flips the mode from the mobile console or through `GET`/`POST /api/execution-mode`. The endpoint is deliberately not gated by the policy, so the kill switch can always be lifted again.
- A destructive tool call is never executed directly. The server returns `202` with an approval record, and the grant is bound to the session that requested it; another session cannot confirm or deny it.
- The delete capability is a module-private symbol that never reaches the browser, so a client cannot forge the explicit confirmation.
- First-run setup requires an installation code for any caller that is not on the appliance itself.

## 反向代理与 TLS 终止 (Reverse Proxy and TLS Termination)

Agent 的网页控制台默认跑在明文 HTTP 上。直接暴露到局域网是可以接受的（前提是网络本身可信），
但只要把它放到一个 TLS 终止的反向代理后面，就必须清楚下面三件事的相互关系。

### sameOrigin 校验

- 所有会改变状态的接口（`/api/setup`、`/api/session`、`/api/logout` 以及各个 `POST`/`PUT`/`DELETE` 接口）
  在处理请求之前都会执行同源校验：请求头的 `Origin` 必须与服务端算出来的外部来源
  `externalOrigin(req).origin` 完全相等，否则直接返回 `403 Forbidden origin`。
- 缺少 `Origin` 头（例如某些非浏览器客户端）同样视为不匹配并被拒绝。这条检查是防 CSRF 的第一道防线，
  它不依赖会话 Cookie 是否存在。
- 外部来源是这样算出来的：协议取 `X-Forwarded-Proto`（可信时）或连接本身的 `http/https`，
  主机取 `X-Forwarded-Host`（可信时）或 `Host` 头，二者拼成 `protocol://host`。
- 因此反代的 `Host` 与 `X-Forwarded-Host` 必须与浏览器地址栏里的主机名完全一致，否则前端的所有写操作都会 403。

### AGENT_TRUST_PROXY 的取舍

- `AGENT_TRUST_PROXY` 的默认值是 `0`。此时服务**不信任** `X-Forwarded-Proto` 与 `X-Forwarded-Host`，
  只有来自回环地址（`127.0.0.1` / `::1`）的对端请求例外。
- 原因是直连场景下这两个头完全由客户端伪造：任何能直连 Agent 端口的人都可以设置
  `X-Forwarded-Host: <自己的主机名>`，把同源校验的基准偷偷换成自己控制的来源。
  默认不信任转发头，就让这种伪造失去意义。
- 把它设成 `1` 的前提是：Agent 端口只对本机或反代可见，外部无法绕过反代直连。
  满足这个前提时，Agent 才会用转发头判断浏览器的来源。
- 如果既有反代又没设 `AGENT_TRUST_PROXY=1`，最典型的症状是所有写操作 403：
  浏览器发的是 `https://nas.example.com`，而 Agent 算出来的是 `http://nas.example.com`（缺端口的 Host 头也不一致）。

### Cookie 的 Secure 属性

- 登录成功后设置的会话 Cookie 是 `nas_agent_session`，带 `HttpOnly` 和 `SameSite=Strict`，
  `Secure` 属性则由 `externalOrigin(req).secure` 决定，也就是“服务端认为这次请求是不是 https”。
- 反代后面浏览器走的是 https，但 Agent 只看到明文 http；只有打开 `AGENT_TRUST_PROXY=1`
  并由反代正确地设置 `X-Forwarded-Proto: https`，这个 Cookie 才会带上 `Secure`。
- 少了 `Secure` 的 Cookie 会在明文连接上被原样发送，等于把一个有效的会话凭据暴露在局域网里。
  所以反代部署必须同时满足：外部用 https、转发头正确、且 `AGENT_TRUST_PROXY=1`。

### 明文 HTTP 部署的风险

- 登录密码、首启 setup code、会话 Cookie 都会以明文经过网络，同网段的任何设备都能嗅探或重放。
- 一旦会话 Cookie 被截获，攻击者不需要密码就能直接访问控制台。
- setup code 也一样：它必须从终端或服务日志里读取，浏览器里输入后会走一次明文 HTTP POST。
- 结论：局域网内部使用明文 HTTP 时，把主机视为可信网络；一旦要跨网段、跨 VLAN 或暴露到公网，
  就必须用反代做 TLS 终止，并按上面的规则设置 `AGENT_TRUST_PROXY=1`。

完整的 nginx / fnOS 门户示例与排查清单见 [Phase 139 — 反向代理部署](phase-139-reverse-proxy-deployment.md)。

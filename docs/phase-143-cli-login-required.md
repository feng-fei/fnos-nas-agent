# Phase 143 — Official CLI Login Guidance

## The problem

A fresh install of the official fnOS Skill is not usable on the first try, and the
console did not say why.

The official CLI answers a read-only call on a profile that was never logged in
with:

```
failed to get system info from localhost:5666: saved proxy session is required; run login first
```

The failure classifier in `apps/fnos-nas-agent/app/trim-cli-health.mjs` matched
neither the scope rule, nor the expired-session rule, nor the network rule, so the
call fell through to the catch-all `unexpected` category:

| Field | Before | After |
| --- | --- | --- |
| `errorCategory` | `unexpected` | `login_required` |
| `statusCode` | 502 | 401 |
| `connectionStatus` | `failed` | `auth_required` |
| `authenticated` | `null` | `false` |
| `message` | 官方 CLI 请求失败，详细输出已隐藏。 | 官方 CLI 尚未完成 OAuth 登录。 |
| `nextAction` | 先检查连接配置和 profile 状态，再重新运行只读连接检测。 | 先按「授权引导」页生成的命令在终端执行官方 CLI 的 login，完成浏览器授权后再运行连接检测。 |

A 502 with "详细输出已隐藏" tells an operator nothing, while the actual cause is
a single missing `login` step.

## The change

`apps/fnos-nas-agent/app/trim-cli-health.mjs` gains a dedicated failure rule.

- `login_required` is a first-class kind with `statusCode: 401`,
  `connectionStatus: "auth_required"` and `authenticated: false`.
- It is matched by `run login first`, `login first`, `not logged in`,
  `no saved session`, `saved proxy session is required`, `session is required`,
  `must be logged in`, `尚未登录` and `请先登录`.
- The rule is evaluated **after** `auth_required`, so an expired or rejected
  session (`401 unauthorized`, `please login`, `token expired`) keeps its own
  category and its own refresh-then-login guidance.
- The classifier still never returns, logs or persists the raw diagnostic, so the
  CLI output cannot leak a session file path or a token into the API response.

The console needed no change: `apps/fnos-nas-agent/app/ui/pages.js` already
renders `error`, `nextAction` and `errorCategory` from the response, and the
`/api/agent/trim-cli/test` route already forwards `401` unchanged
(`apps/fnos-nas-agent/app/server.mjs:1091`).

## Operator flow that now works

1. Install and enable the official fnOS Skill, then press
   「安装官方 CLI（当前平台）」.
2. Press 「检测官方 CLI 连接」.
3. The console now answers `401` with 「官方 CLI 尚未完成 OAuth 登录。」 and points
   to the 授权引导 page instead of a generic 502.
4. Run the generated `login` command in a terminal as the Agent service account,
   complete the browser authorization, and paste the one-time code back.
5. Press 「检测官方 CLI 连接」 again: the read-only probe succeeds and the
   `fnos.*` tools become usable.

## Verification

- `tests/phase-143-cli-login-required.test.mjs` (5 cases) covers the never
  logged-in classification, the leak guard, the expired-session category, the
  public failure kind list and the adapter mapping.
- `tests/trim-cli-health.test.mjs` keeps passing: the existing expired-session
  case still resolves to `auth_required`.
- The failure was observed on the real device (HTNAS, fnOS 3.x, official fnOS
  Skill 0.1.1, trim-cli 7,601,568 bytes, ELF 64-bit x86-64) right after the CLI
  binary was installed and before the OAuth login was completed.

## Boundaries

- The Agent never performs the OAuth login itself. The login command is printed
  for the operator and the one-time code is entered in the operator's terminal.
- The credentials stay in the CLI profile under the Agent private data
  directory; the Agent only executes the binary and reads the answer.

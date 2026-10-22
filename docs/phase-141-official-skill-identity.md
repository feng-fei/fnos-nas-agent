# Phase 141 — Official Skill identity

## The problem

Phase 136 made the server compute the static review of a Skill archive itself
(`manifestReview.reviewedBy === "server"`) instead of trusting a conclusion sent
by the browser. That closed the hole where a client could declare its own
archive as reviewed.

One condition survived the rewrite, though, and it was the wrong one. The
official-package check still compared the **name the operator typed** with
`fnos`:

- `apps/fnos-nas-agent/app/skill-installer.mjs` refused to install the CLI
  when `record.name.toLowerCase() !== "fnos"`,
- `apps/fnos-nas-agent/app/server.mjs` looked for the official binary with
  `enabled.find(item => item.name.toLowerCase() === "fnos" && ...)`,
- `apps/fnos-nas-agent/app/ui/pages.js` only rendered the
  "安装官方 CLI（当前平台）" button for a Skill whose typed name was exactly
  `fnos`.

A Skill registered under the name `fnos-skiil` therefore behaved like a broken
installation even though the archive was the genuine official package: the
button was missing, the installer would have answered `400 Only a quarantined
official fnOS Skill archive can provide the CLI`, and the tool registry kept
reporting `providerAvailable: false` because the binary path provider never
found an official record.

That is the same class of bug Phase 136 set out to remove: the operator's
typing deciding the server's trust decision.

## The rule

The identity of the official package is now derived from the server-side
review alone, in one shared place:

`apps/fnos-nas-agent/app/skill-official-package.mjs`

```js
export function isOfficialFnosPackage(record) {
  // the review was produced by the server,
  // the reviewed manifest declares the official "fnos" package name,
  // and the review was made against exactly the archive the record points at.
}
```

A record qualifies when:

| Condition | Why |
| --- | --- |
| `manifestReview.reviewedBy === "server"` | the conclusion was computed here, not sent by a browser |
| `manifestReview.name === "fnos"` | the archive's own manifest declares the official package |
| `manifestReview.archiveSha256 === record.archiveSha256` | the review describes this exact archive |
| `record.quarantineFile === "skill-quarantine/<sha256>.zip"` | the bytes still live in the quarantine area |

The Skill name is only a display label and is deliberately **not** part of the
rule. The server, the installer and the console all call the same helper, so
they cannot drift apart.

## What changed

| File | Change |
| --- | --- |
| `apps/fnos-nas-agent/app/skill-official-package.mjs` | new shared rule |
| `apps/fnos-nas-agent/app/skill-installer.mjs` | installs the CLI for any server reviewed official archive, whatever the typed name is |
| `apps/fnos-nas-agent/app/server.mjs` | the binary path provider resolves the official CLI through the same rule; the install endpoint keeps a `403` refusal as `403` instead of collapsing it into `500` |
| `apps/fnos-nas-agent/app/ui/pages.js` | the "官方 fnOS 包" badge and the install button follow the same rule, so a renamed official package still shows them |
| `apps/fnos-nas-agent/app/ui/core.js` | Chinese explanation for the install refusal |
| `tests/phase-141-official-skill-identity.test.mjs` | the rule is covered directly, including the renamed case |

## How to use the official CLI

1. Import the official package (ZIP upload or GitHub import). The server
   reviews it and shows a `官方 fnOS 包` badge. The name you type is free text.
2. Approve and enable the Skill.
3. Press `安装官方 CLI（当前平台）`. Only the binary for the current Linux
   architecture is extracted; nothing else is unpacked and no Skill
   instruction is executed.
4. The official read-only `fnos.*` tools become available. The console shows
   `CLI 已安装且可执行` and, after a successful probe,
   `OAuth 授权与 API 连通性已验证`.

The CLI still needs its own login. The agent never forwards OAuth codes and
never collects passwords or tokens: run the official CLI login in a terminal
on the NAS, then press `检测官方 CLI 连接` in the console.

## Tests

`tests/phase-141-official-skill-identity.test.mjs` covers the rule itself
(renamed official package, client declared review, mismatched archive digest,
foreign manifest name) and asserts that the installer, the server and the
console all use the shared helper and no longer read the typed name.

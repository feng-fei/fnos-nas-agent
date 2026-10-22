# Phase 142 — Official CLI manifest paths

## The problem

Phase 141 removed the last dependence on the name the operator typed, so the
"安装官方 CLI（当前平台）" button finally appears for the official package
that is registered under a different name. Pressing it exposed the next
refusal:

```
400 Package manifest does not declare the expected official fnOS CLI binary
```

The official archive stores its manifest at the package root, and the paths
inside that manifest are relative to that root:

```json
{
  "name": "fnos",
  "version": "0.1.1",
  "entry": "SKILL.md",
  "bin": {
    "linux-x64": "bin/trim-cli-linux-x64",
    "linux-arm64": "bin/trim-cli-linux-arm64"
  }
}
```

The installer compared that declaration with the **archive relative** path of
the same file:

```js
manifest.bin?.[target.key] !== target.entry   // "bin/trim-cli-linux-x64" !== "fnos/bin/trim-cli-linux-x64"
```

The two spellings describe the same file, so the comparison could never hold
and the official CLI could never be installed from the official archive.

## The rule

`apps/fnos-nas-agent/app/skill-installer.mjs` now resolves the declared path
against the package folder before comparing it:

```js
export function resolveManifestEntry(manifest, key) {
  const declared = manifest?.bin?.[key];
  // "bin/trim-cli-linux-x64" and "fnos/bin/trim-cli-linux-x64" both resolve
  // to the archive entry "fnos/bin/trim-cli-linux-x64".
}
```

The resolution refuses anything that could leave the package folder:

| Declared value | Result |
| --- | --- |
| `bin/trim-cli-linux-x64` | `fnos/bin/trim-cli-linux-x64` |
| `fnos/bin/trim-cli-linux-x64` | `fnos/bin/trim-cli-linux-x64` |
| `./fnos/bin/trim-cli-linux-x64` | `fnos/bin/trim-cli-linux-x64` |
| `../../etc/passwd` | rejected |
| `bin/../../evil` | rejected |
| `fnos/../evil` | rejected |
| `bin//trim-cli` | rejected |

The resolved entry still has to be **exactly** the entry the current platform
expects, and the extracted bytes still have to pass the ELF check for the
target architecture. Only that one file is written; the rest of the archive is
never unpacked.

## Verified on the device

The whole official flow was replayed on the fnOS device with the released
official archive (`6fd226ac…`, 17.7 MiB, 51 entries):

1. `POST /api/skills/import` with the ZIP → the server reviews it and reports
   `reviewedBy: "server"`, `manifestReview.name: "fnos"`, 19 findings for the
   binary entries it does not scan.
2. `POST /api/skills/{id}/transition` → `approved`, then `enabled`.
3. `POST /api/skills/{id}/install-cli` → `{"installed":true,"platform":"linux-x64","sizeBytes":7601568}`.
   The binary lands at `<data dir>/skill-tools/<skill id>/trim-cli` with mode
   `0700`, and `file` reports an `ELF 64-bit LSB pie executable, x86-64`.
4. `GET /api/tools` → every `fnos.*` tool flips to `providerAvailable: true`.
5. The installed CLI answers: `trim-cli --profile home system host-name`
   reports `saved proxy session is required; run login first`, which is the
   expected next step — the agent never performs the OAuth login.

## The remaining step is the operator's

The CLI needs its own OAuth session. The console generates the exact command
(`sudo -u <service user> -- env HOME=<data dir> XDG_CONFIG_HOME=<data dir>/.config <binary> --profile home --host … --port … --scheme … login --no-open`),
it prints an authorization URL, and the one time code is pasted back into the
same terminal. The agent never receives an OAuth code, a password or a token.

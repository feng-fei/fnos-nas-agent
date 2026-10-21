# Native FPK validation plan

Official reference material:
- [fnOS developer guide](https://developer.fnnas.com/docs/)
- [Manifest configuration](https://fnapps-doc.tnnevol.cn/development/manifest)
- [Lifecycle scripts](https://fnapps-doc.tnnevol.cn/development/lifecycle)
- [fnpack build guide](https://fnapps-doc.tnnevol.cn/build/fnpack)

## Current status

The `apps/fnos-nas-agent/` directory is packaged by CI into an unsigned x86 test FPK. The Node.js executable and PNG icons are generated only in an isolated CI staging copy; they are not committed. CI validates the package with pinned fnpack 1.2.3, inspects archive structure, and verifies SHA-256/manifest consistency. This does **not** certify installation or lifecycle behavior on any fnOS version. The manifest/lifecycle contract still requires testing on a disposable fnOS device.

## Required before release acceptance

1. Confirm the bundled Node.js 26.x runtime starts on the target fnOS build; do not download runtime dependencies during NAS installation.
2. Validate manifest and lifecycle environment variables against current fnOS docs and fnpack 1.2.3.
3. Confirm desktop entry, authentication flow, and app-port behavior on the target device. The app exposes a web management interface and must remain on a trusted network; do not expose it directly to the public internet.

## Build and test sequence

The GitHub Actions pipeline builds the test artifact automatically. For a separate manual build, use a development machine with the official `fnpack` CLI installed:

```sh
bash -n apps/fnos-nas-agent/cmd/main
bash -n apps/fnos-nas-agent/cmd/install_callback
bash -n apps/fnos-nas-agent/cmd/uninstall_callback
cd apps/fnos-nas-agent
fnpack build
```

Only install the CI artifact after verifying its checksum, and only on a disposable test fnOS device. Test first-run setup, authentication/session expiry, start, status, stop, restart, task recovery, read-only tools, audit/task file permissions, upgrade, rollback, uninstall and data retention. Record the exact artifact checksum. The NAS is not to be used as a build host and CI does not install anything on a NAS.

## Acceptance criteria

- The app installs and uninstalls without modifying unrelated NAS settings.
- Start/status/stop work through fnOS application management.
- The health page reports `executionEnabled: false`.
- No shell/Skill/model execution is enabled.
- Logs contain no tokens, passwords, or environment dumps.
- No runtime download or package installation occurs on the NAS.
- LAN access remains disabled until an authentication flow is implemented and verified.

# Native FPK validation plan

Official reference material:
- [fnOS developer guide](https://developer.fnnas.com/docs/)
- [Manifest configuration](https://fnapps-doc.tnnevol.cn/development/manifest)
- [Lifecycle scripts](https://fnapps-doc.tnnevol.cn/development/lifecycle)
- [fnpack build guide](https://fnapps-doc.tnnevol.cn/build/fnpack)

## Current status

The `apps/fnos-nas-agent/` directory is a draft native FPK template. It is **not yet a buildable or installable package**. The bundled Node.js executable and valid PNG icon assets are intentionally not checked into the repository, and the manifest/lifecycle contract still needs validation with the official `fnpack` version.

## Blockers before build

1. Pin and verify an official Node.js Linux x64 runtime, then bundle it under `app/bin/node`. Do not rely on Node.js being preinstalled on fnOS and do not download runtime dependencies during NAS installation.
2. Add valid fnOS desktop PNG icons in `app/ui/images/`.
3. Validate the exact app destination and lifecycle environment variables against current fnOS docs and `fnpack`.
4. Validate executable bits on `cmd/main` and callbacks after checkout/build.
5. Confirm the desktop entry's access behavior. The server currently binds to loopback for safety, so LAN/phone access is intentionally not enabled yet.

## Build and test sequence

On a development machine with the official `fnpack` CLI installed:

```sh
bash -n apps/fnos-nas-agent/cmd/main
bash -n apps/fnos-nas-agent/cmd/install_callback
bash -n apps/fnos-nas-agent/cmd/uninstall_callback
cd apps/fnos-nas-agent
fnpack build
```

Only after `fnpack build` succeeds should the generated FPK be manually installed on a test fnOS device. Then test install, start, status, stop, restart, upgrade, and uninstall. The NAS is not to be used as a build host and no installation should be attempted from this draft.

## Acceptance criteria

- The app installs and uninstalls without modifying unrelated NAS settings.
- Start/status/stop work through fnOS application management.
- The health page reports `executionEnabled: false`.
- No shell/Skill/model execution is enabled.
- Logs contain no tokens, passwords, or environment dumps.
- No runtime download or package installation occurs on the NAS.
- LAN access remains disabled until an authentication flow is implemented and verified.

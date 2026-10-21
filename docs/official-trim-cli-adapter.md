# Official fnOS trim-cli read-only adapter

The Agent can optionally call the official `trim-cli` executable through a small allowlisted adapter. This adapter intentionally does not download or bundle a CLI whose source, release version, checksum, license, and architecture have not yet been verified.

## Configure

- Set `TRIM_CLI_PATH` to the absolute path of the official executable.
- Optionally set `TRIM_CLI_PROFILE` (defaults to `home`; allowed characters are letters, digits, underscore, and hyphen).
- Complete OAuth login yourself using the official CLI's interactive flow. The Agent does not request passwords, handle authorization codes, or automate browser authorization.
- Keep the CLI profile/session storage protected with restrictive filesystem permissions.

## Read-only commands currently allowlisted

`system info`, `file ls`, `file ls-dir`, `file usage`, `app list`, `docker image ls`, `download ls`, `monitor cpu`, `storage pools`, and `user info`.

All invocations use `execFile` with a fixed argument array and no shell. Unknown commands and extra arguments are rejected. Each request has a timeout and output cap; raw stderr is suppressed because CLI errors may contain sensitive session data. No write, raw API, media, service-control, or storage mutation command is exposed.

## Current limitation

This is the execution adapter and test foundation, not a claim that `trim-cli` is bundled or authenticated on the NAS. The FPK still needs a verified, pinned, architecture-compatible official CLI distribution before this capability can be enabled by default. CI tests use a stub executable interface and do not validate a real fnOS OAuth session or NAS device.

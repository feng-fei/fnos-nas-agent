# Official fnOS trim-cli read-only adapter

The Agent integrates the official trim-cli as an optional capability provider. An explicit TRIM_CLI_PATH override takes precedence; otherwise the Agent uses the CLI installed from the quarantined official fnOS Skill package only while the matching official Skill is enabled.

## Install and authorize

1. Import the official fnOS Skill ZIP; the archive remains quarantined and is checked before any installation.
2. Review the static manifest, approve the Skill, install the current-platform CLI binary, then enable the Skill.
3. In the Agent web UI, open the guided official CLI OAuth setup and generate the login command.
4. Run the command in a trusted NAS terminal. It uses the Agent service account and the Agent's private data/config directories. The Agent does not execute the generated command itself.
5. Complete the official interactive OAuth Authorization Code + PKCE flow in your own browser and paste the one-time code directly into the CLI prompt. Never send the code or token to the Agent/chat.
6. Return to the web UI and run the read-only connection test.

The managed installer supports Linux x64 and ARM64, extracts only the platform-matched trim-cli binary from the exact reviewed/quarantined archive, validates the ELF architecture, and does not run Skill instructions. The complete archive is not generally extracted.

## Configuration

- Set TRIM_CLI_PATH only when intentionally overriding the Skill-managed binary; the path must identify the official executable.
- TRIM_CLI_PROFILE defaults to home.
- Agent calls use HOME=<Agent data directory> and XDG_CONFIG_HOME=<Agent data directory>/.config so OAuth profile storage is private and available to the service account.
- The guided login command supports HTTPS, explicit opt-in for HTTP on a trusted network, an explicit option for trusted self-signed HTTPS certificates, and the CLI's interactive refresh flow.

## Read-only commands currently allowlisted

system info, file ls, file ls-dir, file usage, app list, docker image ls, download ls, monitor cpu, storage pools, user info, monitor beep-supported, photos folders, and photos search.

All invocations use execFile with a fixed argument array and no shell. Unknown commands and extra arguments are rejected. Each request has a timeout and output cap; raw stderr is suppressed because CLI errors may contain sensitive session data. No arbitrary shell, raw API passthrough, write command, media mutation, service-control, or storage mutation command is exposed through this adapter.

## Current limitations

A generated command is never run by the Agent web service. The Agent never collects the OAuth code or displays/stores access or refresh tokens. The read-only connection test reports success only after an actual system.info probe; executable presence is not proof of authentication or API reachability. CI uses Node.js 26 and stubs/contracts; real OAuth and fnOS device acceptance remain separate validation steps.

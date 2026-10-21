# Web authentication foundation (Phase 3)

## Current behavior

- The FPK starts on `0.0.0.0` so the browser can reach the first-run setup screen from the trusted LAN. In setup mode, the only available features are health/status and one-time token initialization; NAS execution, Skills, and model calls remain disabled.
- First run asks the user to set a 32–256 character access token or generate a 256-bit random token in the browser. The server writes it to `$TRIM_PKGVAR/access-token` with mode `0600`; the token is never written to logs. Setup is one-time and rejects requests after a token is configured.
- On subsequent starts, the FPK startup script reads the token from `$TRIM_PKGVAR/access-token` without printing it.
- The web UI exchanges the token for a random in-memory session ID. The cookie is HttpOnly and SameSite=Strict; sessions expire after eight hours and are lost on restart.
- Login and setup check Origin, limit JSON request size, use constant-time comparison for token login, and rate-limit repeated failures per source address.
- `GET /api/health` is intentionally public and exposes only basic health/version and whether authentication is configured. `/api/tools` requires a session and returns no executable tools.
- The server receives the app data path through `AGENT_DATA_DIR`, set by the FPK lifecycle script from `TRIM_PKGVAR`.

## First-run setup

1. Open `http://<NAS-IP>:18787` from a **trusted private LAN**.
2. On the first-run setup screen, generate a random token or enter one with at least 32 characters.
3. Save the token in a password manager before leaving the page. After setup, the token is not displayed again.
4. Log in using the token.

The setup endpoint is exposed to the trusted LAN only because the first-run token does not exist yet. A device already on that LAN could race to complete setup. Therefore, only use this flow on a private network you trust; do not expose port 18787 to the internet or untrusted Wi-Fi. This first-run setup is acceptable only while the app has no NAS command execution, Skill execution, or model-call capability.

## Transport limitation

The current FPK serves plain HTTP. The setup token and login token are therefore not encrypted in transit. Use this build only on a trusted private LAN; do not use it over public Wi-Fi, expose it to the internet, or configure router port forwarding. For use across untrusted networks, put the service behind a properly configured HTTPS reverse proxy or implement native TLS before enabling remote access. The session cookie intentionally does not set `Secure` because the current server is HTTP; this must change when HTTPS is terminated by the app itself. Never add NAS execution features until authentication, transport, authorization, and risky-action approval are reviewed together.

## Important limitations

- Sessions are in-memory, so restarting the app logs out all users.
- This is a single shared-token proof of concept, not per-user identity or role-based authorization.
- In-memory rate limiting is best-effort and resets on restart.
- Authentication is not a substitute for network isolation.

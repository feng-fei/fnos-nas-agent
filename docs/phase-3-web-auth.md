# Web authentication foundation (Phase 3)

## Current behavior

- The packaged server binds to `127.0.0.1` unless `AGENT_ACCESS_TOKEN` is configured with at least 32 characters.
- The FPK startup script reads the token from `$TRIM_PKGVAR/access-token` without printing it. When present and valid, the service binds to `0.0.0.0` for trusted-LAN access.
- The web UI accepts the token and exchanges it for a random in-memory session ID. The cookie is HttpOnly and SameSite=Strict; sessions expire after eight hours and are lost on restart.
- Login checks Origin, limits JSON request size, uses constant-time comparison for equal-length token candidates, and rate-limits repeated failures per source address.
- `GET /api/health` is intentionally public and exposes only basic health/version and whether authentication is configured. `/api/tools` requires a session.
- NAS execution, Skill import/execution, and model calls remain disabled.

## Configure the token for an FPK

Do not commit or paste the token into GitHub issues, chat, screenshots, or logs. On the NAS, use the app's private data directory reported by fnOS as `TRIM_PKGVAR`; create an `access-token` file there with a cryptographically random value of at least 32 characters and restrict permissions to the app account. For example, in an authorized shell where the correct app data path is known:

```sh
umask 077
openssl rand -hex 32 > /path/to/app-data/access-token
chmod 600 /path/to/app-data/access-token
```

Replace the example path with the actual app data directory; do not run this example with the literal placeholder. Restart the app through the fnOS app center after creating the file. Without a valid token file, the app remains loopback-only.

## Transport limitation

The current FPK serves plain HTTP. The login token is therefore not encrypted in transit. Use this build only on a trusted private LAN; do not use it over public Wi-Fi, expose it to the internet, or configure router port forwarding. For use across untrusted networks, put the service behind a properly configured HTTPS reverse proxy or implement native TLS before enabling remote access. The session cookie intentionally does not set `Secure` because the current server is HTTP; this must change when HTTPS is terminated by the app itself. Never add NAS execution features until authentication, transport, authorization, and risky-action approval are reviewed together.

## Important limitations

- Sessions are in-memory, so restarting the app logs out all users.
- This is a single shared-token proof of concept, not per-user identity or role-based authorization.
- In-memory rate limiting is best-effort and resets on restart.
- Authentication is not a substitute for network isolation.

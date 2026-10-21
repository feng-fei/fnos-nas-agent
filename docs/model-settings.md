# Runtime AI model settings

The authenticated mobile UI can configure an OpenAI-compatible Chat Completions provider without editing environment variables.

- Only HTTPS endpoints are accepted; URL credentials and fragments are rejected.
- The API key is never returned by the settings API or shown again in the UI. Leaving the key field blank preserves the saved key.
- Settings are stored in `AGENT_DATA_DIR/model-settings.json` with restrictive file permissions (0600); the containing directory is created with mode 0700.
- The saved key is stored as a local secret in the NAS app data directory, not encrypted by this application. Protect the NAS account, app data directory, and backups accordingly.
- Disabling the model preserves settings so it can be re-enabled without re-entering the key.
- Model planning remains constrained to the allowlisted tools and each tool's schema. Arbitrary shell commands, Skill execution, and service control remain unavailable.

Validation: Node.js 24/26 test suite, release gates, and Node.js 26 FPK build. Use a trusted network and do not expose this personal NAS management UI directly to the public internet.

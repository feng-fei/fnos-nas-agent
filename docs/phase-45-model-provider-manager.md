# Phase 45 — Model provider management

## What is included

The mobile Agent UI can add, edit, enable/disable, test, select as default, and delete multiple OpenAI-compatible Chat Completions providers. Each provider stores a display name, full HTTPS endpoint, model ID, encrypted API key, enabled state, and the last safe connection-test summary. Provider records are limited to 20.

The UI only receives public metadata and a hasApiKey boolean. It never reads an existing key back. During editing, leaving the key field empty preserves the saved key; replacing the key requires entering a new value; the explicit clear-key option removes it and disables that provider. A provider cannot be set as default unless it is enabled and has a key.

## Endpoint format

Enter the complete Chat Completions endpoint, such as:

- https://api.openai.com/v1/chat/completions
- The corresponding full endpoint supplied by another OpenAI-compatible provider

HTTPS is required. Embedded URL credentials, query strings and fragments are rejected. The provider endpoint and model ID must be valid before saving. The connection test sends a short non-sensitive prompt and records only success/failure, HTTP status category, duration and a fixed human-readable message. Provider response bodies and raw errors are never returned or stored.

## Key storage

The provider list file, model-providers.json, stores AES-256-GCM-encrypted API keys. The 256-bit encryption key is stored separately in model-provider.key; both files are created with mode 0600, using a private AGENT_DATA_DIR. Keys are decrypted only inside the server process for model calls and explicit connection tests. Public status, UI payloads, audit events and provider test results never include the key.

Back up the private data directory as a unit. If encrypted provider records exist but the encryption-key file is missing or invalid, loading fails closed and does not silently replace the key. Keep filesystem access to the Agent data directory restricted to the service account and trusted administrators.

This protects stored credentials from accidental disclosure via UI/API, ordinary JSON inspection, and logs. It is not a defense against a fully compromised NAS root account, which can read both files or inspect the running process.

## Runtime switching and fallback

Selecting a default provider changes the configuration used by subsequent Agent model requests without restarting the service. Disabling the current default clears the managed default; the Agent stops using the managed model until an enabled provider is selected. Existing AGENT_MODEL_ENDPOINT, AGENT_MODEL_API_KEY, AGENT_MODEL_NAME, and AGENT_MODEL_ENABLED=true environment configuration remains a fallback when no provider has been added through the UI, for backwards compatibility.

When provider settings contain records but have no enabled default, the managed model adapter stays disabled rather than accidentally choosing an arbitrary provider. Rules-first direct requests and registered tools remain available without a model.

## API and verification

The session-protected /api/models endpoints provide listing and CRUD; per-provider actions test connectivity and select the default. State-changing requests require same-origin checks. Audit records contain the route and HTTP status only—never request bodies or credentials.

Tests cover encryption and file modes, concurrent additions, provider persistence/reload, default switching, secret clearing/replacement, failure sanitization, session/origin restrictions, UI controls and runtime adapter switching. Node.js 26 CI runs the entire suite, release safety gates and embedded UI syntax validation. A successful simulated provider test is not proof of connectivity to a user's actual provider; configure and test your own provider in the UI.

# Phase 94 — Model catalog HTTP integration

Exercises authenticated model catalog discovery against a local OpenAI-compatible mock server.

- Verifies same-origin enforcement prevents outbound catalog requests.
- Verifies the server requests the derived `/models` endpoint with the saved API key.
- Verifies duplicate, empty, non-string, and control-character model IDs are excluded.
- Verifies the returned catalog omits credentials and raw upstream diagnostics.
- Uses a temporary Agent data directory and a loopback mock provider only.

Node.js 26 CI coverage; no external model service is contacted.

# Phase 8: Agent core and model routing

## Scope

This phase connects the authenticated web endpoint to a rules-first agent core, a pluggable OpenAI-compatible model adapter, and the existing code-defined read-only tool registry. It is a single synchronous task cycle with a task ID and explicit completion/failure status, not a background job scheduler.

## Routing

- Exact common requests for system status, storage capacity, and network interfaces use deterministic rules and never call the model.
- Ambiguous requests may use the model only when all server-side environment settings are present and explicitly enabled.
- If no model is configured, the agent explains supported direct requests and performs no speculative action.
- User input is limited to 2,000 characters.

## Model configuration

Configure only on the server process, never in browser storage or a public API:

- `AGENT_MODEL_ENABLED=true`
- `AGENT_MODEL_ENDPOINT=https://provider.example/v1/chat/completions`
- `AGENT_MODEL_API_KEY=...`
- `AGENT_MODEL_NAME=...`

The endpoint must use HTTPS and contain no embedded credentials or fragment. The API key is read from the process environment and is never returned by status endpoints or intentionally logged. Use the app's private environment/configuration mechanism when deploying; do not put secrets in source control, FPK metadata, or client-side JavaScript. The provider endpoint must be explicitly trusted by the operator.

## Tool safety

The model can return only a bounded JSON plan. The server accepts at most three tool requests, each with an empty argument object. Every request is still passed through the existing code-defined tool registry; unknown tool IDs and invalid arguments fail closed. No shell, subprocess, Docker, writes, service control, Skill execution, or dynamic import is exposed.

## Limits

- OpenAI-compatible chat-completions JSON response format; provider compatibility varies.
- 15-second request timeout and bounded provider response parsing.
- No retry loop, long-term conversation memory, background tasks, or autonomous multi-turn planning.
- HTTP remains unencrypted; use only a trusted LAN or place behind a correctly configured TLS reverse proxy.
- This PR does not install or configure the model on a production NAS.

## Validation

Run `npm test` on Node.js 26.x and build/inspect the FPK using Node.js 26. Tests cover direct routing, unconfigured behavior, model plan validation, invalid tools/arguments, and configuration safety.

# Phase 54 — Expanded model provider presets

Adds quick-start presets for:

- Moonshot AI / Kimi OpenAI-compatible Chat Completions
- Zhipu AI BigModel
- OpenRouter multi-provider gateway

Presets contain only public endpoint metadata and documentation links. They never contain model IDs that are guaranteed to be enabled for a particular account, API keys, or user settings. Users must select a model ID available to their own account and provide their own key. The existing HTTPS endpoint validator remains authoritative.

These are endpoint presets only; provider availability and account entitlements must be verified by the user with the connection-test and catalog-discovery controls.

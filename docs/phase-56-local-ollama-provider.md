# Phase 56 — Local Ollama provider

Adds a preset for Ollama's OpenAI-compatible Chat Completions endpoint on the same NAS host.

## Endpoint policy

- HTTPS endpoints continue to be supported.
- Plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1`.
- Remote HTTP endpoints such as private LAN IPs are rejected to avoid sending model prompts or keys over unencrypted connections.
- The endpoint must still end in `/chat/completions`; the existing request and response bounds continue to apply.

## Setup

1. Install and start Ollama on the same host as fnos-nas-agent.
2. Pull a model and confirm its exact ID with `ollama list`.
3. Choose “本机 Ollama（仅回环地址）”, keep the loopback endpoint, enter the model ID, and use `ollama` as the placeholder API key (Ollama normally ignores it).
4. Save and test the connection. Model discovery works only if the local service exposes the OpenAI-compatible `/v1/models` endpoint.

This does not enable arbitrary command execution or install/run Ollama for the user. CI covers validation contracts only; no local Ollama server or real NAS was contacted.

# Phase 53 — Model catalog discovery

## Purpose

Allow the mobile model manager to discover model IDs from OpenAI-compatible provider catalogs instead of requiring users to guess model names.

## Behavior

- Authenticated, same-origin `POST /api/models/:id/catalog` endpoint.
- Uses the provider's stored API key server-side and requests `GET /models` derived from its configured Chat Completions endpoint.
- Bounds response bytes using the existing model-provider response limit and uses the configured request timeout.
- Returns only unique, printable model IDs (maximum 100) and optional bounded `owned_by` labels.
- Does not persist or return credentials, provider response bodies, or catalog results.
- Mobile UI lets a user choose a discovered ID and review it in the existing edit form; it does not silently change or save the active model.

## Limits

Discovery requires the provider to implement the OpenAI-compatible `GET /models` endpoint. Providers that do not expose a catalog can still be configured manually. This is a network API integration test, not validation against a real provider or fnOS NAS.

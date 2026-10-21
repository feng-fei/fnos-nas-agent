# Phase 86 — Skill archive import HTTP integration

Exercises the real HTTP route for quarantined Skill ZIP import in an isolated temporary data directory.

- Unauthenticated import requests are rejected.
- Cross-origin requests are rejected before archive processing.
- Unsupported content types return 415.
- Malformed ZIP payloads return 400 and do not create Skill records.
- The test checks the Skill list remains empty after all rejected requests.

The test does not extract or execute imported content, and it does not contact a real NAS.

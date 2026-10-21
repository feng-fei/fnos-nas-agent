# Phase 55 — Mobile Skill inventory search and filters

- Search by Skill name, version, source label, archive digest, review note, manifest name/description, and declared capabilities.
- Filter by lifecycle state.
- Keep pagination server-side, with the existing maximum of 100 results per request and 500 stored records.
- Search terms are trimmed and bounded to 100 characters; the API rejects oversized query parameters.
- Search is metadata-only. It does not inspect, extract, or execute quarantined archives.

The UI is intended for mobile and desktop browsers. Automated Node.js 26 tests cover search matching, state filtering, and pagination; they do not constitute real-browser or fnOS NAS validation.

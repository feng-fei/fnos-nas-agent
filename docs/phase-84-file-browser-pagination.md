# Phase 84 — File browser pagination

The file browser API now accepts a bounded `offset` in addition to the existing bounded page size. The mobile UI loads 100 entries at a time and shows total directory count plus previous/next controls.

- Sorting remains server-side before slicing, so page order is stable for an unchanged directory.
- Invalid or excessively large offsets are rejected at the HTTP boundary.
- Configured-root and symlink restrictions remain unchanged.
- Local name/type filtering applies to the currently loaded page; navigating pages fetches the next server-side slice.

# Phase 84 — File browser pagination

The file browser API now accepts a bounded `offset` in addition to the existing bounded page size. The mobile UI loads 100 entries at a time and shows total directory count plus previous/next controls.

- Sorting, filename search and file-type filtering are applied server-side before slicing, so matches and ordering span the entire current directory rather than only the visible page.
- Invalid or excessively large offsets are rejected at the HTTP boundary.
- Configured-root and symlink restrictions remain unchanged.
- The UI reports both matching entries and the total directory entry count; changing a filter resets pagination to the first page.

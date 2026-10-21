# Phase 79 — Mobile file search and sorting

The mobile file browser now filters the currently listed directory by case-insensitive filename, restricts the view to files or folders, and sorts the visible entries by name, size, or modification time.

- Search is debounced to avoid issuing a request for every keystroke.
- Filtering and sorting are presentation-only; the API still applies its configured-root boundaries and entry-count limit.
- The controls do not change file contents or bypass confirmation requirements.
- Node.js 26 CI includes a UI contract test.

The browser only sorts the entries returned for the current directory; it does not claim to search recursively or beyond the API's bounded listing.

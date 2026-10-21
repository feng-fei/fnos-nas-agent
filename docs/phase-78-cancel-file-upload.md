# Phase 78 — Cancel mobile uploads

Adds a cancel button while an upload is in progress. The browser aborts the active XMLHttpRequest and refreshes the current directory afterward because an abort near completion cannot guarantee that the server did not finish writing the file.

- Cancel is disabled when no upload is active.
- The selected file remains selected after cancellation so the user can retry deliberately.
- No automatic retry occurs.
- Existing authentication, same-origin validation and server-side upload limits remain unchanged.

# Phase 77 — Mobile upload progress

The mobile file manager now uses an upload-progress event to show percentage completion for file uploads.

- Keeps the existing 25 MiB client-side guard and server-side upload limit.
- Sends the same raw `application/octet-stream` body to the existing authenticated same-origin endpoint.
- Disables the upload button while a request is active.
- Shows success/failure status and refreshes the current directory after success.
- Does not retry automatically after a network error because the server may have completed the upload before the connection failed.

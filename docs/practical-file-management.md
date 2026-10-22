# Practical file management

Extends the authenticated mobile file browser with bounded UTF-8 text preview, streaming downloads, binary uploads up to 25 MiB, folder creation, rename, move, and delete.

- All paths must resolve inside configured storage roots (AGENT_FILE_ROOTS or discovered /volN volumes).
- Symbolic links are not supported for file actions; storage roots cannot be renamed, moved, or deleted.
- Uploads use a temporary file and a no-overwrite hard-link commit, then clean up the temporary file.
- Existing files are never overwritten by uploads or rename/move operations.
- Text preview is limited to 1 MiB and rejects binary or invalid UTF-8 data.
- Folder deletion is non-recursive and only succeeds for empty folders.
- Delete requires explicit confirmation in the authenticated same-origin API; the mobile UI also asks for confirmation.
- Intended for a trusted LAN. CI does not validate permissions or storage layout on a real fnOS device.

Validation: Node.js 26.x tests, release gates, syntax checks, and Node.js 26 FPK packaging.

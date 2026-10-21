# Phase 107 — Quarantined Skill source preview

Adds a read-only file browser for imported Skill archives so a reviewer can inspect the actual source behind static-review findings.

- Lists recognized text/source files from a quarantined ZIP, including `SKILL.md`, supported scripts/config files, and common secret config files.
- Previews only exact entries from a validated archive, only when the path is on the text-preview allowlist, and only when the uncompressed entry is at most 64 KiB.
- Revalidates the archive structure and SHA-256 digest each time, checks the quarantine directory/file filesystem types, and checks archive size before reading.
- Reads/decompresses the selected entry in memory. No archive paths are extracted to disk and no source is executed.
- Requires an authenticated session; listing and preview use GET-only routes. File names, sizes and preview content are returned only to the current caller and are not saved in task history or audit records.
- The mobile page builds a file selector and renders returned source solely with `textContent`; it never inserts archive content as HTML.

Validation: tests cover file listing, UTF-8 preview, oversized/binary rejection, tampered archive hash detection, metadata-only Skills, authenticated route contracts, and no extraction to disk. Node.js 26 CI; no real NAS is contacted.

# Phase 35 — Agent Text-File Creation

## Capability
- Register `files.create-text` as a server-classified routine write tool.
- Accept a destination directory, safe basename, and UTF-8 content; cap encoded content at 1 MiB.
- Use exclusive temporary-file creation, fsync, and a no-overwrite hard link before removing the temporary file.
- Reject NUL content, invalid names, paths outside configured storage roots, symlink targets, and existing destinations.
- Add a Chinese deterministic intent: `创建文本文件 <文件名> 于 <目录路径> 内容：<文本内容>`.

## Permission and execution
The tool is a normal `write` operation and does not require repeated confirmation. Its risk comes from the server-side registry, not the model. Deletion remains destructive and uses the separate one-time confirmation flow. Arbitrary shell and imported Skill execution remain disabled.

## Validation
Tests cover UTF-8 content, byte size, no-overwrite behavior, unsafe paths, oversized content, and temporary-file cleanup. Require the full Node.js 26.x test suite and Node.js 26 FPK packaging before merge. CI does not replace real fnOS device acceptance.

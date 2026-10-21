# Phase 122 — File Mutation Directory Descriptor Confinement

## Problem

Upload, text creation, folder creation, rename/move, and deletion validated a directory path before later operating on the pathname. A path change between those steps could redirect a mutation, invalidate a source identity check, or make the returned path refer to a different directory.

## Changes

- Open mutation parent directories with Linux directory/no-follow flags and verify device/inode identity against the directory validated by the storage-root policy.
- Perform temporary file creation, atomic hard-link publication, folder creation, rename/move, and deletion through the opened directory descriptor.
- Recheck parent path identity after publishing a new file or folder; when a detected race occurs, remove the just-created target through the still-open descriptor and return a retryable conflict.
- Verify rename/move/delete source identity using metadata from the opened parent descriptor rather than reopening the source pathname.
- Add regression tests for upload, text creation, folder creation, rename, and deletion with symlink replacement both before and immediately after opening the parent directory.

## Platform and validation

The hardened file operations rely on Linux /proc/self/fd paths, available in the target Linux-based fnOS runtime. Non-Linux platforms fail closed for these operations rather than silently reverting to pathname-based mutation.

Run:

```sh
npm test
npm run check:release
```

These regression tests exercise the Linux CI filesystem. Real fnOS filesystem and device acceptance remains a separate staging gate.

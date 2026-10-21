# Phase 120 — File Browser Directory Descriptor Confinement

## Problem

The file browser validated a directory path with realpath/lstat and then called readdir or inspected children via the pathname. If that directory or one of its path components was replaced after validation, a listing/search could follow the replacement and disclose names or metadata outside the configured storage roots.

## Changes

- Open the validated directory with no-follow/directory flags and verify the opened device/inode matches the object observed during validation.
- Read directory entries and child metadata through the opened descriptor using Linux /proc/self/fd paths, not a mutable directory pathname.
- Repeat root confinement and directory identity validation for each directory traversed by recursive search.
- Return a conflict for a directory changed during the validation/open window.
- Add race tests for a symlink swap before open and replacement of the original path after the directory descriptor is opened.

## Platform and validation

The descriptor-backed directory enumeration uses Linux /proc/self/fd, which is available on the target Linux-based fnOS runtime. Other platforms fail closed for this operation rather than silently falling back to path-based enumeration.

Run:

```sh
npm test
npm run check:release
```

These tests exercise the Linux CI filesystem race boundary. They do not replace real fnOS filesystem and device acceptance.

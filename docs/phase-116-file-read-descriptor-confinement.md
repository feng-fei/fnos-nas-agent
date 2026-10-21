# Phase 116 — File Read Descriptor Confinement

## Problem

The file browser validated a path with realpath and lstat, then reopened the path by name for preview, checksum, or download. A path entry could be replaced after validation but before the subsequent read. In that race window, a symlink could redirect a read to a file outside the configured storage root.

## Changes

- Open validated read targets with O_NOFOLLOW where supported and compare the opened descriptor's device/inode to the object observed during path validation.
- Return a conflict when the path changes during the validation/open window instead of following the replacement.
- Read previews through the validated handle with a strict 1 MiB read bound, including files that grow during a read.
- Calculate SHA-256 from the same validated handle and keep the existing changed-during-checksum detection.
- Stream downloads from the already-open file handle rather than reopening the validated path by name.
- Add regression tests that swap the target path to a symlink after lstat and verify preview, checksum, and download fail closed.

## Validation

Run:

```sh
npm test
npm run check:release
```

The race tests validate the application-level open/identity checks on the CI Linux filesystem. They do not replace a security review on the target fnOS filesystem or real-device staging acceptance.

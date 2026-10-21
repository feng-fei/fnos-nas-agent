# Phase 122 — File Mutation Directory Descriptor Confinement

## Problem

File creation, uploads, directory creation, move/rename, and deletion validated target paths with realpath/lstat and then performed filesystem operations through those original path strings. A concurrent process could replace a validated parent directory between those steps; a subsequent write or deletion could then act through the replacement path rather than the directory that was validated.

## Changes

- Open mutation parent directories with `O_DIRECTORY | O_NOFOLLOW`, then compare the opened descriptor's device/inode with the previously validated directory metadata.
- Address child entries through `/proc/self/fd/<fd>/<name>` so parent-directory renames or symlink replacement do not redirect the operation to an outside directory.
- Revalidate source child type and device/inode through the anchored descriptor before rename, move, or delete.
- Perform upload/text-file temporary creation, hard-link publication, and temporary cleanup relative to the opened parent descriptor.
- Add race tests for create-text, upload, mkdir, rename, move and delete when a validated directory or source parent is swapped to an outside symlink.

## Validation and limits

Run `npm test` and `npm run check:release` on Node.js 26.x. The implementation uses Linux `/proc/self/fd`, consistent with the target fnOS environment, and fails closed on other platforms. These tests validate the local Linux race boundary, not a deployed NAS.

Directory descriptor confinement prevents a replaced parent pathname from redirecting operations outside configured storage roots. Destination-name races for rename/move remain a separate atomic no-replace concern and must not be interpreted as solved by this phase. Real fnOS filesystem-permission and lifecycle testing is still required.
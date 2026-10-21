# Phase 82 — ZIP local-record overlap rejection

The Skill ZIP inspector now rejects archives whose central-directory entries point to overlapping local file records or data ranges. This blocks ambiguous layouts where one entry is embedded inside another entry's payload while both are presented as separate files in the central directory.

- Keeps the existing single-disk, stored/deflated ZIP support.
- Does not extract or execute entries during inspection.
- Adds a crafted overlapping-record fixture alongside existing path, size, symlink and CRC tests.

# Desktop icon assets

The fnOS desktop icons are **generated automatically at packaging time** by
`scripts/generate-fpk-icons.py`. No icon file has to be placed here by hand,
and no generated PNG is committed to the repository.

The generator writes the following files into the isolated CI staging copy of
`apps/fnos-nas-agent/`:

- `app/ui/images/icon_0.png` and `app/ui/images/icon_1.png` — the icons the
  desktop config references (`app/ui/config`, `icon_{0}.png`).
- `app/ui/images/icon_64.png` and `app/ui/images/icon_256.png` — size variants
  kept for fnOS versions that request an explicit size.
- `ICON.PNG` and `ICON_256.PNG` at the package root.

Because generation happens in the staging copy, the source checkout stays free
of binary artifacts. A build is still not release-ready until the generated
icon set and the bundled Node.js runtime are both present in the FPK.

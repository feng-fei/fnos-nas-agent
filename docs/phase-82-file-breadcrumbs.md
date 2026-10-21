# Phase 82 — Mobile file navigation breadcrumbs

The file browser displays a breadcrumb trail for the current directory. Parent segments are clickable and the current segment is marked as the current location.

- Breadcrumbs are built only when the current path is beneath a path returned as a configured storage root.
- Each navigation click uses the existing directory-loading endpoint and its server-side path validation.
- This is a navigation aid, not an authorization boundary or recursive search.

Node.js 26 CI checks the UI contract; no real NAS is contacted.

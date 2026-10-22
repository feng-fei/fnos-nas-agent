# Phase 135 — Mobile First User Interface

The console was built as a desktop page and squeezed onto a phone. This phase
rebuilds it as a mobile-first application and splits the single file into a
static shell, one stylesheet and two scripts.

## What was actually broken

The old interface was measured in a 390 × 844 viewport before anything was
changed:

| Problem | Measurement |
| --- | --- |
| Navigation overflowed the screen | `.workspace-nav` held eight links on one line, about 570 px wide, running past the 390 px viewport to x = 747 |
| Page switching scrolled the layout sideways | The container jumped to x = -145 when a page was selected |
| No persistent navigation | No bottom bar, no side rail, the header scrolled away at y = 127 |
| Every page was one long scroll | The status page was 1479 px tall and the agent page 1607 px, against an 844 px viewport |
| Raw diagnostics on the page | A 420 px tall `<pre id="diagnostics">` was rendered directly into the overview |
| No button hierarchy | Every action was the same 40 px text button, including destructive ones |
| Forms were walls | The model provider form ran eight fields in one flat column |
| Filters stacked | The file page search, type and sort controls were three full width rows |

The desktop layout was not broken, it simply stretched the same single column
and wasted the horizontal space.

## The new structure

| File | Responsibility |
| --- | --- |
| `app/ui/index.html` | Static application shell: header, navigation, page sections |
| `app/ui/styles.css` | The design system: tokens, components, breakpoints |
| `app/ui/core.js` | API client, session, router, toast and modal helpers, output formatting |
| `app/ui/pages.js` | Rendering for every page |

The shell is markup only. The runtime layout builder that used to construct the
top bar, the navigation and the page panel from JavaScript is gone; the pages
are plain `<section class="page">` elements that the router shows and hides.

Both scripts are classic scripts, loaded in order, sharing one global scope.
The output formatting helpers stay in one contiguous block at the top of
`core.js` so the formatting test can execute them in isolation.

## Mobile first navigation

- Below 768 px the console shows a sticky header and a bottom tab bar with
  the four daily pages — overview, files, assistant, tools — plus a *More*
  entry that opens a drawer with models, skills, audit and security.
- From 768 px the drawer becomes a left navigation rail.
- From 1120 px the rail widens and the content column gets a maximum width.
- The header keeps the page title, the connection state, the execution mode
  and the refresh and logout actions visible at all times.

## The design system

`styles.css` defines the tokens and the components the shell uses: `.app`,
`.app-header`, `.app-body`, `.nav-rail`, `.tabbar`, `.page`, `.card`,
`.stat`, `.field`, `.list`, `.badge`, `.pill`, `.banner`, `.empty`, `.toast`,
`.modal`, `.drawer`, `.menu`, `.chat`, `.composer`, `.skeleton` and the button
variants `.btn--primary`, `.btn--secondary`, `.btn--ghost` and `.btn--danger`.

Dark mode follows the operating system, `prefers-reduced-motion` is honoured,
and interactive targets are at least 44 px so they stay reachable with a thumb.
The legacy class names `.hidden`, `.card` and `.muted` keep working, which
keeps the existing user interface tests valid.

## Serving the assets

`GET /` returns the shell. `GET /ui/<file>` returns the stylesheet and the
scripts. The route uses a fixed allow list of extensions, accepts only file
names made of letters, digits, dots, dashes and underscores, rejects any name
containing `..`, and answers with `cache-control: no-cache` so an upgraded
package never shows a stale interface.

## Tests

The twenty-seven user interface tests read the shell and the scripts through
`tests/helpers/ui-source.mjs`, which concatenates them into the same bundle
the release gates read. The release gates in
`scripts/check-release-gates.mjs` use the same bundle, so a contract that
holds in the tests also holds before a release.

`tests/phase-135-mobile-first-user-interface.test.mjs` adds the contract for
the new structure itself: no inline script, no inline style block, the three
external assets, the mobile navigation landmarks, the overview counters, the
breakpoints in the stylesheet and the allow list in the server.

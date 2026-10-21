# Phase 95 — Searchable model catalog picker

Improves the mobile model-provider catalog picker for providers that return many model IDs.

- Adds an accessible search field matching model ID and provider owner metadata.
- Shows the filtered count and makes the “Use selected model” action unavailable when there are no matches.
- Keeps the catalog bounded to the first 100 returned models and explicitly indicates when the list is capped.
- Selecting a model still only fills the edit form; it never saves or changes the active provider until the user submits the existing save action.
- Model IDs and provider metadata continue to be rendered as text, not HTML.

Validation: Node.js 26 UI regression tests. No provider API or real NAS is contacted.

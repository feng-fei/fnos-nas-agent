# Phase 57 — Mobile model catalog picker

Replaces the browser prompt-based model selection with an inline, accessible picker in the model-provider card.

- Displays model IDs using text nodes, with the optional provider owner label.
- Preserves the currently configured model when it appears in the discovered catalog.
- Supports explicit “Use selected model” and “Cancel” actions.
- Selecting a model fills the existing edit form but does not submit it or alter the active provider.
- Keeps the saved API key server-side; the key field remains blank and its existing “leave blank to retain” behavior is preserved.

This is browser UI contract coverage, not an end-to-end browser or real-provider test.

# Phase 67 — Task result details

Completed task cards now provide an expandable result section for tool outputs, limited to the first 10 result items and 12,000 rendered characters. Results are assigned through `textContent`, not interpreted as HTML. The summary message remains visible without expanding details.

The UI limits rendering, not the server payload size; results remain in-memory only and are not written to task history persistence. This is a browser UI contract test, not an end-to-end browser test.

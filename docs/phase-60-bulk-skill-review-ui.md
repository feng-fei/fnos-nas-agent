# Phase 60 — Mobile bulk Skill review

Adds selection checkboxes to Skill cards and a bulk target-state control.

- Select individual records or all visible records on the current page.
- Apply one target state and optional review note to up to 20 selected records per request (the API limit remains authoritative).
- Show aggregate success/failure counts.
- Remove successful records from selection and retain failed records for correction/retry.
- Ask for confirmation before bulk rejection.
- The existing state transition policy still determines whether each requested transition is legal. Imported Skill code remains unexecuted.

This PR is stacked on Phase 57 because both update the same UI file. After Phase 57 is merged, retarget this PR to `main`; Phase 59's API must also be merged before the UI is usable end-to-end.

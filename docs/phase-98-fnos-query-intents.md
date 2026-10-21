# Phase 98 — Direct natural-language fnOS queries

Extends the rules-first Agent path to cover existing official fnOS CLI read-only operations that were already registered but lacked direct natural-language aliases.

- Adds direct routes for fnOS system information, volume usage by bounded integer ID, directory-segment listing, and beep-support capability checks.
- Uses the existing internal tool IDs and schemas; does not add new CLI commands or arbitrary flags.
- Direct requests do not call the model and invoke only registered tools.
- Volume IDs and paths are validated against the existing input schemas before invocation.
- The beep-support operation checks capability only; it does not trigger the device.

Validation: Node.js 26 unit tests with a fake tool registry. No CLI binary or real NAS is invoked.

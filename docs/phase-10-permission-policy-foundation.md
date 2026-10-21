# Phase 10: permission policy foundation

This phase introduces a centralized, fail-closed risk policy for future Skill/tool integrations.

## Policy behavior

- `read-only`: allowed by default.
- `write` and `destructive`: denied by default and report that explicit approval is required.
- Enabling a risk tier in configuration is not enough by itself: a write/destructive request must also carry an explicit approved decision.
- `unknown` or unrecognized risk values are denied.
- Policy evaluation does not execute tools, issue approval tokens, or enable arbitrary execution. The runtime remains execution-disabled for write/destructive operations.

## Integration contract

Any future tool or Skill adapter must classify risk on the server side, evaluate the policy before execution, and separately implement authenticated, one-time, task-bound approval. Never trust a risk label or approval flag supplied directly by a model or browser. Do not connect this policy to write-capable tools until approval binding, expiry, replay prevention, audit logging, and cancellation are implemented and tested.

## Validation

The policy has unit tests for default allow/deny behavior, explicit approval, unknown risks, invalid configuration, and the execution-disabled invariant. CI should run Node.js 24/26 test suites and Node.js 26 FPK package inspection.

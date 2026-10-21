# Phase 10: permission policy foundation

This phase introduces a centralized risk policy designed for a personal NAS assistant: normal work stays convenient, while risky actions require explicit confirmation.

## Policy behavior

- `read-only`: allowed by default.
- `write` and `destructive`: enabled as capabilities by default, but **never execute without an explicit approved decision**. No separate configuration switch is needed for ordinary confirmed operations.
- Approval remains a separate, mandatory decision: a write/destructive request without approval is blocked; with approval, the default policy allows it.
- `unknown` or unrecognized risk values are denied.
- This module still does not execute tools or issue approval tokens. Runtime integration must bind confirmation to the exact action and arguments. Unknown risk classes remain blocked until classified by a server-side executor.

## Integration contract

Any future tool or Skill adapter must classify risk on the server side, evaluate the policy before execution, and separately implement authenticated, one-time, task-bound approval. Never trust a risk label or approval flag supplied directly by a model or browser. Do not connect this policy to write-capable tools until approval binding, expiry, replay prevention, audit logging, and cancellation are implemented and tested.

## Validation

The policy has unit tests for default allow/deny behavior, explicit approval, unknown risks, invalid configuration, and the execution-disabled invariant. CI should run Node.js 24/26 test suites and Node.js 26 FPK package inspection.

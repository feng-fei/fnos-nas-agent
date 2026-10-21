import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalLedger } from "../apps/fnos-nas-agent/app/approval-ledger.mjs";

const action = (overrides = {}) => ({
  taskId: "task_12345678", toolId: "storage.resize", risk: "write", args: { disk: "data", size: 100 }, ...overrides
});

test("approval grant is bound to task, tool, arguments and risk and can be consumed only once", () => {
  let n = 0;
  const ledger = createApprovalLedger({ token: () => "x".repeat(32) + (++n), now: () => 1000 });
  const grant = ledger.issue(action());
  assert.equal(ledger.snapshot().executionEnabled, false);
  assert.equal(ledger.consume({ ...action(), token: grant.token }).approved, true);
  assert.equal(ledger.consume({ ...action(), token: grant.token }).approved, false);
});
test("canonical argument key order does not change the action binding", () => {
  const ledger = createApprovalLedger({ token: () => "a".repeat(40), now: () => 1000 });
  const grant = ledger.issue(action({ args: { alpha: 1, beta: { z: true, a: "x" } } }));
  assert.equal(ledger.consume({ ...action({ args: { beta: { a: "x", z: true }, alpha: 1 } }), token: grant.token }).approved, true);
});
test("mismatched action cannot consume a grant", () => {
  const ledger = createApprovalLedger({ token: () => "b".repeat(40), now: () => 1000 });
  const grant = ledger.issue(action());
  assert.equal(ledger.consume({ ...action({ args: { disk: "other", size: 100 } }), token: grant.token }).reason, "action-mismatch");
  assert.equal(ledger.consume({ ...action(), token: grant.token }).approved, true);
});
test("expired grants and revoked task grants cannot be consumed", () => {
  let time = 1000, n = 0;
  const ledger = createApprovalLedger({ token: () => String(++n).padEnd(40, "z"), now: () => time, ttlMs: 1000 });
  const first = ledger.issue(action());
  time = 2000;
  assert.equal(ledger.consume({ ...action(), token: first.token }).approved, false);
  time = 3000;
  const second = ledger.issue(action());
  assert.equal(ledger.revokeTask("task_12345678"), 1);
  assert.equal(ledger.consume({ ...action(), token: second.token }).approved, false);
});
test("pending approvals are bounded and unknown risk levels fail closed", () => {
  let n = 0;
  const ledger = createApprovalLedger({ token: () => String(++n).padEnd(40, "q"), now: () => 1000, maxPending: 1 });
  ledger.issue(action());
  assert.throws(() => ledger.issue(action({ taskId: "task_abcdefgh" })), { statusCode: 429 });
  assert.throws(() => ledger.issue(action({ risk: "read-only" })), TypeError);
  assert.throws(() => createApprovalLedger({ ttlMs: 999999 }), TypeError);
});

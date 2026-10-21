import test from "node:test";
import assert from "node:assert/strict";
import { createPermissionPolicy } from "../apps/fnos-nas-agent/app/permission-policy.mjs";

test("read-only operations are allowed by default", () => {
  const policy = createPermissionPolicy();
  assert.deepEqual(policy.evaluate({ risk: "read-only" }), { allowed: true, requiresApproval: false, reason: "read-only-allowed" });
});

test("write and destructive operations require confirmation but need no separate opt-in", () => {
  const policy = createPermissionPolicy();
  assert.equal(policy.evaluate({ risk: "write" }).allowed, false);
  assert.equal(policy.evaluate({ risk: "write" }).requiresApproval, true);
  assert.equal(policy.evaluate({ risk: "destructive", approved: true }).allowed, true);
});

test("explicit approval is sufficient for supported write and destructive actions by default", () => {
  const policy = createPermissionPolicy();
  assert.equal(policy.evaluate({ risk: "write" }).allowed, false);
  assert.equal(policy.evaluate({ risk: "write", approved: true }).allowed, true);
  assert.equal(policy.evaluate({ risk: "destructive", approved: true }).allowed, true);
});

test("unknown and invalid risk levels fail closed", () => {
  const policy = createPermissionPolicy({ allowUnknown: true });
  assert.equal(policy.evaluate({ risk: "unknown" }).allowed, false);
  assert.equal(policy.evaluate({ risk: "shell" }).allowed, false);
});

test("policy rejects non-boolean configuration and advertises execution remains disabled", () => {
  assert.throws(() => createPermissionPolicy({ allowWrite: "yes" }), TypeError);
  assert.equal(createPermissionPolicy().snapshot().executionEnabled, false);
});

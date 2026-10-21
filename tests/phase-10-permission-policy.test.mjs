import test from "node:test";
import assert from "node:assert/strict";
import { createPermissionPolicy } from "../apps/fnos-nas-agent/app/permission-policy.mjs";

test("read-only operations are allowed by default", () => {
  const policy = createPermissionPolicy();
  assert.deepEqual(policy.evaluate({ risk: "read-only" }), { allowed: true, requiresApproval: false, reason: "read-only-allowed" });
});

test("ordinary writes are allowed by default without repeated confirmation", () => {
  const policy = createPermissionPolicy();
  assert.deepEqual(policy.evaluate({ risk: "write" }), { allowed: true, requiresApproval: false, reason: "write-allowed" });
  assert.equal(policy.evaluate({ risk: "write", approved: false }).allowed, true);
});

test("destructive operations require explicit confirmation", () => {
  const policy = createPermissionPolicy();
  assert.deepEqual(policy.evaluate({ risk: "destructive" }), { allowed: false, requiresApproval: true, reason: "explicit-approval-required" });
  assert.equal(policy.evaluate({ risk: "destructive", approved: true }).allowed, true);
});

test("explicit policy overrides can disable writes or destructive actions", () => {
  assert.equal(createPermissionPolicy({ allowWrite: false }).evaluate({ risk: "write" }).allowed, false);
  assert.equal(createPermissionPolicy({ allowDestructive: false }).evaluate({ risk: "destructive", approved: true }).allowed, false);
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

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionPolicy, EXECUTION_MODES } from "../apps/fnos-nas-agent/app/execution-policy.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "fnos-execution-policy-"));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("the three execution modes are the only accepted modes", () => {
  assert.deepEqual([...EXECUTION_MODES], ["normal", "read-only", "halted"]);
  assert.equal(Object.isFrozen(EXECUTION_MODES), true);
});

test("default mode allows reads and writes but never an unapproved destructive call", () => {
  const policy = createExecutionPolicy({ env: {} });
  assert.equal(policy.mode(), "normal");
  assert.equal(policy.source(), "default");
  assert.deepEqual(policy.evaluate({ risk: "read-only" }), { allowed: true, reason: "allowed", requiresApproval: false, statusCode: 200 });
  assert.deepEqual(policy.evaluate({ risk: "write" }), { allowed: true, reason: "allowed", requiresApproval: false, statusCode: 200 });
  assert.deepEqual(policy.evaluate({ risk: "destructive" }), { allowed: false, reason: "approval-required", requiresApproval: true, statusCode: 409 });
  assert.equal(policy.evaluate({ risk: "destructive", approved: true }).allowed, true);
});

test("only a real boolean approval unlocks a destructive call", () => {
  const policy = createExecutionPolicy({ env: {} });
  assert.equal(policy.evaluate({ risk: "destructive", approved: "true" }).allowed, false);
  assert.equal(policy.evaluate({ risk: "destructive", approved: 1 }).allowed, false);
  assert.equal(policy.evaluate({ risk: "destructive", approved: true }).allowed, true);
});

test("read-only mode keeps reads and refuses every mutating risk", () => {
  const policy = createExecutionPolicy({ env: { AGENT_EXECUTION_MODE: "read-only" } });
  assert.equal(policy.mode(), "read-only");
  assert.equal(policy.source(), "environment");
  assert.deepEqual(policy.evaluate({ risk: "read-only" }), { allowed: true, reason: "allowed", requiresApproval: false, statusCode: 200 });
  assert.deepEqual(policy.evaluate({ risk: "write" }), { allowed: false, reason: "read-only-mode", requiresApproval: false, statusCode: 403 });
  assert.deepEqual(policy.evaluate({ risk: "destructive", approved: true }), { allowed: false, reason: "read-only-mode", requiresApproval: false, statusCode: 403 });
});

test("halted mode is a kill switch that blocks even read-only calls", () => {
  const policy = createExecutionPolicy({ env: { AGENT_EXECUTION_MODE: "halted" } });
  assert.equal(policy.mode(), "halted");
  for (const risk of ["read-only", "write", "destructive"]) {
    assert.deepEqual(policy.evaluate({ risk, approved: true }), { allowed: false, reason: "kill-switch", requiresApproval: false, statusCode: 503 });
  }
});

test("unknown or missing risk levels fail closed", () => {
  const policy = createExecutionPolicy({ env: {} });
  for (const risk of [undefined, null, "", "shell", "unknown", "READ-ONLY", 42]) {
    assert.deepEqual(policy.evaluate({ risk }), { allowed: false, reason: "unknown-risk", requiresApproval: false, statusCode: 403 });
  }
  assert.deepEqual(policy.evaluate(), { allowed: false, reason: "unknown-risk", requiresApproval: false, statusCode: 403 });
});

test("the state file wins over the environment variable", async () => {
  const { directory, cleanup } = await fixture();
  try {
    await writeFile(join(directory, "execution-mode.json"), JSON.stringify({ mode: "read-only", updatedAt: new Date().toISOString() }), "utf8");
    const policy = createExecutionPolicy({ dataDir: directory, env: { AGENT_EXECUTION_MODE: "normal" } });
    await policy.reload();
    assert.equal(policy.mode(), "read-only");
    assert.equal(policy.source(), "state-file");
    assert.equal(policy.evaluate({ risk: "write" }).allowed, false);
  } finally {
    await cleanup();
  }
});

test("a malformed or unsupported state file is ignored and the next priority is used", async () => {
  const { directory, cleanup } = await fixture();
  try {
    await writeFile(join(directory, "execution-mode.json"), "{ this is not json", "utf8");
    const fallback = createExecutionPolicy({ dataDir: directory, env: { AGENT_EXECUTION_MODE: "halted" } });
    await fallback.reload();
    assert.equal(fallback.mode(), "halted");
    assert.equal(fallback.source(), "environment");

    await writeFile(join(directory, "execution-mode.json"), JSON.stringify({ mode: "banana" }), "utf8");
    const unsupported = createExecutionPolicy({ dataDir: directory, env: {} });
    await unsupported.reload();
    assert.equal(unsupported.mode(), "normal");
    assert.equal(unsupported.source(), "default");
  } finally {
    await cleanup();
  }
});

test("setMode persists the mode with 0600 permissions and refreshes the in-memory state", async () => {
  const { directory, cleanup } = await fixture();
  try {
    const policy = createExecutionPolicy({ dataDir: directory, env: {} });
    const result = await policy.setMode("read-only");
    assert.deepEqual(result, { mode: "read-only", source: "state-file" });
    assert.equal(policy.mode(), "read-only");
    assert.equal(policy.source(), "state-file");
    assert.equal(policy.evaluate({ risk: "write" }).allowed, false);
    const persisted = JSON.parse(await readFile(join(directory, "execution-mode.json"), "utf8"));
    assert.equal(persisted.mode, "read-only");
    assert.equal(typeof persisted.updatedAt, "string");
  } finally {
    await cleanup();
  }
});

test("setMode rejects an unknown mode with a TypeError", async () => {
  const { directory, cleanup } = await fixture();
  try {
    const policy = createExecutionPolicy({ dataDir: directory, env: {} });
    assert.throws(() => policy.setMode("banana"), TypeError);
    assert.throws(() => policy.setMode(null), TypeError);
    assert.throws(() => policy.setMode(""), TypeError);
  } finally {
    await cleanup();
  }
});

test("setMode refuses to write when the state directory is missing", async () => {
  const { directory, cleanup } = await fixture();
  try {
    const policy = createExecutionPolicy({ dataDir: join(directory, "missing"), env: {} });
    await assert.rejects(policy.setMode("halted"), error => error.statusCode === 500);
    assert.equal(policy.mode(), "normal");
  } finally {
    await cleanup();
  }
});

test("an unsupported environment value falls back to the default mode", () => {
  const policy = createExecutionPolicy({ env: { AGENT_EXECUTION_MODE: "everything" } });
  assert.equal(policy.mode(), "normal");
  assert.equal(policy.source(), "default");
});

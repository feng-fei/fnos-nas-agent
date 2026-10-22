import test from "node:test";
import assert from "node:assert/strict";
import { createOverviewService } from "../apps/fnos-nas-agent/app/overview.mjs";

const FIXED_NOW = () => Date.parse("2026-10-22T04:00:00.000Z");

test("empty dependencies produce the full default snapshot without throwing", () => {
  const service = createOverviewService({ now: FIXED_NOW });
  const snapshot = service.snapshot();

  assert.equal(snapshot.generatedAt, "2026-10-22T04:00:00.000Z");
  assert.deepEqual(snapshot.app, { name: "fnos-nas-agent", version: snapshot.app.version });
  assert.equal(typeof snapshot.app.version, "string");
  assert.equal(snapshot.health.ok, true);
  assert.equal(snapshot.health.degraded, false);
  assert.deepEqual(snapshot.health.degradedComponents, []);
  assert.deepEqual(snapshot.execution, {
    mode: "normal",
    source: "default",
    modes: ["normal", "read-only", "halted"]
  });
  assert.deepEqual(snapshot.tasks, { queued: 0, running: 0, retained: 0, concurrency: 2 });
  assert.deepEqual(snapshot.skills, { total: 0, pendingReview: 0, enabled: 0 });
  assert.deepEqual(snapshot.models, { providerCount: 0, activeProviderId: null, enabled: false });
  assert.deepEqual(snapshot.approvals, { pending: 0 });
  assert.deepEqual(snapshot.agent, { rulesFirst: true, availableTools: 0, modelEnabled: false });
});

test("execution policy mode and source are passed through", () => {
  const service = createOverviewService({
    executionPolicy: { mode: () => "read-only", source: () => "state-file" },
    now: FIXED_NOW
  });
  const snapshot = service.snapshot();

  assert.equal(snapshot.execution.mode, "read-only");
  assert.equal(snapshot.execution.source, "state-file");
  assert.deepEqual(snapshot.execution.modes, ["normal", "read-only", "halted"]);
});

test("task manager stats are surfaced with a concurrency fallback", () => {
  const service = createOverviewService({
    taskManager: { stats: () => ({ queued: 3, running: 1 }) },
    now: FIXED_NOW
  });
  const snapshot = service.snapshot();

  assert.equal(snapshot.tasks.queued, 3);
  assert.equal(snapshot.tasks.running, 1);
  assert.equal(snapshot.tasks.retained, 0);
  assert.equal(snapshot.tasks.concurrency, 2);
});

test("task counters are derived from a task list when stats are missing", () => {
  const service = createOverviewService({
    taskManager: {
      list: () => ({
        tasks: [
          { id: "a", status: "queued" },
          { id: "b", status: "queued" },
          { id: "c", status: "running" },
          { id: "d", status: "done" }
        ]
      })
    },
    now: FIXED_NOW
  });
  const snapshot = service.snapshot();

  assert.equal(snapshot.tasks.queued, 2);
  assert.equal(snapshot.tasks.running, 1);
  assert.equal(snapshot.tasks.retained, 4);
});

test("skill states are counted into pendingReview and enabled", () => {
  const service = createOverviewService({
    skillStore: {
      list: () => ({
        total: 4,
        skills: [
          { name: "a", state: "pending_review" },
          { name: "b", state: "pending_review" },
          { name: "c", state: "enabled" },
          { name: "d", state: "disabled" }
        ]
      })
    },
    now: FIXED_NOW
  });
  const snapshot = service.snapshot();

  assert.equal(snapshot.skills.total, 4);
  assert.equal(snapshot.skills.pendingReview, 2);
  assert.equal(snapshot.skills.enabled, 1);
});

test("model providers produce providerCount and activeProviderId", () => {
  const service = createOverviewService({
    modelProviderStore: {
      list: () => ({
        activeProviderId: "provider-1",
        providers: [
          { id: "provider-1", enabled: true, hasApiKey: true },
          { id: "provider-2", enabled: false, hasApiKey: false }
        ]
      })
    },
    now: FIXED_NOW
  });
  const snapshot = service.snapshot();

  assert.equal(snapshot.models.providerCount, 2);
  assert.equal(snapshot.models.activeProviderId, "provider-1");
  assert.equal(snapshot.models.enabled, true);
});

test("action approvals accept both the actions wrapper and a bare array", () => {
  const wrapped = createOverviewService({
    actionApprovals: { list: () => ({ actions: [{ id: "a" }, { id: "b" }] }) },
    now: FIXED_NOW
  });
  assert.equal(wrapped.snapshot().approvals.pending, 2);

  const bare = createOverviewService({
    actionApprovals: { list: () => [{ id: "a" }, { id: "b" }, { id: "c" }] },
    now: FIXED_NOW
  });
  assert.equal(bare.snapshot().approvals.pending, 3);
});

test("a throwing upstream method still yields a snapshot", () => {
  const service = createOverviewService({
    health: { version: "1.2.3" },
    executionPolicy: {
      mode: () => { throw new Error("boom"); },
      source: () => { throw new Error("boom"); }
    },
    taskManager: { stats: () => { throw new Error("boom"); } },
    skillStore: { list: () => { throw new Error("boom"); } },
    modelProviderStore: { list: () => { throw new Error("boom"); } },
    actionApprovals: { list: () => { throw new Error("boom"); } },
    agentCore: { status: () => { throw new Error("boom"); } },
    now: FIXED_NOW
  });

  const snapshot = service.snapshot();
  assert.equal(snapshot.app.version, "1.2.3");
  assert.equal(snapshot.execution.mode, "normal");
  assert.equal(snapshot.tasks.queued, 0);
  assert.equal(snapshot.skills.total, 0);
  assert.equal(snapshot.models.providerCount, 0);
  assert.equal(snapshot.approvals.pending, 0);
  assert.equal(snapshot.agent.availableTools, 0);
});

test("agent status contributes rulesFirst, tool count and model state", () => {
  const service = createOverviewService({
    agentCore: {
      status: () => ({ rulesFirst: true, model: { enabled: true }, availableTools: 12 })
    },
    now: FIXED_NOW
  });
  const snapshot = service.snapshot();

  assert.equal(snapshot.agent.rulesFirst, true);
  assert.equal(snapshot.agent.availableTools, 12);
  assert.equal(snapshot.agent.modelEnabled, true);
});

test("the snapshot never leaks secrets, tokens or passwords", () => {
  const service = createOverviewService({
    health: { version: "1.2.3", ok: true },
    executionPolicy: { mode: () => "normal", source: () => "default" },
    taskManager: { stats: () => ({ queued: 1, running: 0, retained: 1, concurrency: 2 }) },
    skillStore: { list: () => ({ skills: [{ name: "a", state: "enabled" }] }) },
    modelProviderStore: {
      list: () => ({
        activeProviderId: "p1",
        providers: [{ id: "p1", enabled: true, hasApiKey: true, apiKey: "sk-secret", token: "tok-secret", password: "pw-secret" }]
      })
    },
    actionApprovals: { list: () => ({ actions: [] }) },
    agentCore: { status: () => ({ rulesFirst: true, availableTools: 3 }) },
    now: FIXED_NOW
  });

  const serialized = JSON.stringify(service.snapshot());
  for (const forbidden of ["apiKey", "token", "password", "sk-secret", "tok-secret", "pw-secret", "secret"]) {
    assert.equal(serialized.includes(forbidden), false, `snapshot must not contain ${forbidden}`);
  }
});

test("the snapshot is JSON-serialisable without circular references", () => {
  const service = createOverviewService({
    executionPolicy: { mode: () => "halted", source: () => "environment" },
    now: FIXED_NOW
  });
  const snapshot = service.snapshot();

  const serialized = JSON.stringify(snapshot);
  assert.equal(typeof serialized, "string");
  const parsed = JSON.parse(serialized);
  assert.deepEqual(parsed.execution, {
    mode: "halted",
    source: "environment",
    modes: ["normal", "read-only", "halted"]
  });
  assert.equal(parsed.app.name, "fnos-nas-agent");
});

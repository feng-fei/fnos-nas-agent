import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScheduledHealthChecks } from "../apps/fnos-nas-agent/app/scheduled-health-checks.mjs";

function createClock(start = "2026-10-22T12:00:00.000Z") {
  let current = Date.parse(start);
  return {
    now: () => new Date(current),
    advance(minutes) { current += minutes * 60_000; }
  };
}

test("scheduled health checks run only registered read-only tools and save bounded summaries", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-scheduled-checks-"));
  const clock = createClock();
  const toolCalls = [];
  const scheduler = createScheduledHealthChecks({
    dataDir,
    now: clock.now,
    runTool: async (toolId, args) => {
      toolCalls.push({ toolId, args });
      if (toolId === "system.status") return {
        memory: { totalBytes: 100, usedBytes: 92 },
        cpu: { logicalCores: 4, loadAverage: [1, 2, 3] }
      };
      if (toolId === "storage.summary") return {
        storage: [{ label: "主存储", totalBytes: 1000, usedBytes: 950, freeBytes: 50, available: true }]
      };
      if (toolId === "network.interfaces") return {
        network: [{ name: "eth0", addresses: [{ address: "192.0.2.2" }] }]
      };
      if (toolId === "fnos.docker.stats") return { data: { active: 2 } };
      if (toolId === "documents.index-status") return { documentCount: 0, partial: false };
      throw new Error("not an allowlisted check");
    }
  });
  try {
    await scheduler.ready;
    const system = await scheduler.create({ name: "系统健康", type: "system", intervalMinutes: 5 });
    const storage = await scheduler.create({ name: "存储健康", type: "storage", intervalMinutes: 10 });
    const network = await scheduler.create({ name: "网络健康", type: "network", intervalMinutes: 15 });
    const docker = await scheduler.create({ name: "Docker 健康", type: "docker", intervalMinutes: 20 });
    const documents = await scheduler.create({ name: "文档库健康", type: "documents", intervalMinutes: 60 });

    const first = await scheduler.runNow(system.id);
    assert.equal(first.run.status, "warning");
    assert.match(first.run.summary, /92%/);
    assert.ok(first.run.findings.some(item => item.includes("90%")));
    assert.deepEqual(toolCalls[0], { toolId: "system.status", args: {} });

    const storageResult = await scheduler.runNow(storage.id);
    assert.equal(storageResult.run.status, "warning");
    assert.match(storageResult.run.summary, /高使用率/);
    assert.ok(storageResult.run.findings.some(item => item.includes("95%")));

    assert.equal((await scheduler.runNow(network.id)).run.status, "ok");
    assert.equal((await scheduler.runNow(docker.id)).run.status, "ok");
    const docResult = await scheduler.runNow(documents.id);
    assert.equal(docResult.run.status, "warning");
    assert.ok(docResult.run.findings.some(item => item.includes("没有已索引文档")));

    const listed = scheduler.list();
    assert.equal(listed.total, 5);
    assert.equal(listed.checks.find(item => item.id === system.id).history.length, 1);
    assert.equal(listed.checks.find(item => item.id === system.id).typeLabel, "系统健康");

    const path = join(dataDir, "scheduled-health-checks.json");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const persisted = await readFile(path, "utf8");
    assert.ok(!persisted.includes("raw cli output"));
    assert.ok(!persisted.includes("apiKey"));
  } finally {
    scheduler.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("scheduled health checks run when due, preserve finite history, and survive restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-scheduled-due-"));
  const clock = createClock();
  let calls = 0;
  let timerCallback;
  let clearedTimer = false;
  const options = {
    dataDir,
    now: clock.now,
    runTool: async toolId => {
      calls++;
      assert.equal(toolId, "network.interfaces");
      return { network: [{ addresses: [{ address: "192.0.2.4" }] }] };
    },
    setIntervalFn(callback, delay) {
      timerCallback = callback;
      assert.equal(delay, 15000);
      return { unref() {} };
    },
    clearIntervalFn() { clearedTimer = true; }
  };
  const scheduler = createScheduledHealthChecks(options);
  try {
    await scheduler.ready;
    const check = await scheduler.create({ name: "定时网络检查", type: "network", intervalMinutes: 5 });
    assert.equal(await scheduler.runDue().then(result => result.ran), 0);
    assert.equal(calls, 0);
    clock.advance(6);
    const due = await scheduler.runDue();
    assert.equal(due.ran, 1);
    assert.equal(calls, 1);
    assert.equal(scheduler.list().checks[0].lastStatus, "ok");

    const restarted = createScheduledHealthChecks(options);
    await restarted.ready;
    assert.equal(restarted.list().checks[0].id, check.id);
    assert.equal(restarted.list().checks[0].history.length, 1);

    assert.equal(restarted.start(), true);
    assert.equal(restarted.start(), false);
    clock.advance(6);
    await timerCallback();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 2);
    assert.equal(restarted.stop(), true);
    assert.equal(restarted.stop(), false);
    assert.equal(clearedTimer, true);
  } finally {
    scheduler.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("scheduled health checks validate types, intervals, duplicate names and update controls", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-scheduled-validation-"));
  const scheduler = createScheduledHealthChecks({ dataDir, runTool: async () => ({}) });
  try {
    await scheduler.ready;
    await assert.rejects(scheduler.create({ name: "bad", type: "shell", intervalMinutes: 10 }), { statusCode: 400 });
    await assert.rejects(scheduler.create({ name: "bad", type: "system", intervalMinutes: 1 }), { statusCode: 400 });
    const check = await scheduler.create({ name: "系统巡检", type: "system", intervalMinutes: 10 });
    await assert.rejects(scheduler.create({ name: "系统巡检", type: "storage", intervalMinutes: 10 }), { statusCode: 409 });
    await assert.rejects(scheduler.update(check.id, { enabled: "false" }), { statusCode: 400 });
    await assert.rejects(scheduler.update(check.id, { shell: "echo" }), { statusCode: 400 });
    const paused = await scheduler.update(check.id, { enabled: false });
    assert.equal(paused.enabled, false);
    assert.equal(paused.nextRunAt, null);
    const resumed = await scheduler.update(check.id, { enabled: true, intervalMinutes: 15 });
    assert.equal(resumed.enabled, true);
    assert.equal(resumed.intervalMinutes, 15);
    assert.ok(resumed.nextRunAt);
    assert.equal((await scheduler.remove(check.id)).deleted, true);
    await assert.rejects(scheduler.runNow(check.id), { statusCode: 404 });
  } finally {
    scheduler.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("scheduler sanitizes provider failures and retains only the latest ten results", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-scheduled-history-"));
  const clock = createClock();
  let calls = 0;
  const scheduler = createScheduledHealthChecks({
    dataDir, now: clock.now,
    runTool: async () => { calls++; throw new Error("raw cli output secret-value"); }
  });
  try {
    await scheduler.ready;
    const check = await scheduler.create({ name: "失败检查", type: "system", intervalMinutes: 5 });
    for (let i = 0; i < 12; i++) {
      clock.advance(6);
      await scheduler.runNow(check.id);
    }
    const listed = scheduler.list().checks[0];
    assert.equal(listed.history.length, 10);
    assert.equal(listed.lastStatus, "error");
    assert.ok(!JSON.stringify(listed).includes("raw cli output"));
    assert.ok(!JSON.stringify(listed).includes("secret-value"));
    assert.equal(calls, 12);
  } finally {
    scheduler.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

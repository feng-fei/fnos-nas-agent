import test from "node:test";
import assert from "node:assert/strict";
import { createTaskManager, publicTask } from "../apps/fnos-nas-agent/app/task-manager.mjs";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function waitFor(predicate, attempts = 80) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return true;
    await tick();
  }
  return predicate();
}

test("publicTask keeps the public field contract and is exported", () => {
  const task = {
    taskId: "task-1", createdAt: "2026-01-01T00:00:00.000Z", startedAt: null, completedAt: null,
    status: "queued", progress: 0, stage: "排队中", cancelRequested: false,
    timeoutMs: 1000, timedOut: false, result: null, error: null
  };
  assert.deepEqual(Object.keys(publicTask(task)).sort(), [
    "cancelRequested", "completedAt", "createdAt", "error", "progress", "result",
    "stage", "startedAt", "status", "taskId", "timedOut", "timeoutMs"
  ]);
  assert.equal(publicTask(task).taskId, "task-1");
});

test("a subscriber receives progress events with the reported value and stage", async () => {
  const manager = createTaskManager({
    execute: async (_input, context) => {
      context.reportProgress(40, "正在扫描");
      return { ok: true };
    }
  });
  const events = [];
  const task = manager.submit({ text: "hello" });
  manager.subscribe(task.taskId, event => events.push(event));
  await waitFor(() => events.some(event => event.type === "done"));
  const progress = events.filter(event => event.type === "progress");
  assert.ok(progress.length >= 1, "expected at least one progress event");
  const last = progress[progress.length - 1];
  assert.equal(last.data.progress, 40);
  assert.equal(last.data.stage, "正在扫描");
  assert.equal(typeof last.at, "string");
  assert.ok(!Number.isNaN(Date.parse(last.at)));
});

test("the event object has the fixed shape { type, at, data }", async () => {
  const manager = createTaskManager({ execute: async () => ({ ok: true }) });
  const events = [];
  const task = manager.submit({});
  manager.subscribe(task.taskId, event => events.push(event));
  await waitFor(() => events.length > 0);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ["at", "data", "type"]);
    assert.ok(["progress", "tool", "approval", "done", "error"].includes(event.type), `unexpected type ${event.type}`);
  }
});

test("a reported tool produces a tool event with a bounded result", async () => {
  const manager = createTaskManager({
    execute: async (_input, context) => {
      context.reportTool("fnos.listDirectory", { entries: ["a", "b"] });
      return { ok: true };
    }
  });
  const events = [];
  const task = manager.submit({});
  manager.subscribe(task.taskId, event => events.push(event));
  await waitFor(() => events.some(event => event.type === "done"));
  const tool = events.find(event => event.type === "tool");
  assert.ok(tool, "expected a tool event");
  assert.equal(tool.data.tool, "fnos.listDirectory");
  assert.deepEqual(tool.data.result, { entries: ["a", "b"] });
  assert.equal("args" in tool.data, false, "the tool event must not carry the tool arguments");
});

test("tools of the finished result are reported when the executor does not report them", async () => {
  const manager = createTaskManager({
    execute: async () => ({ status: "completed", message: "ok", results: [{ tool: "fnos.systemInfo", result: { hostname: "nas" } }] })
  });
  const events = [];
  const task = manager.submit({});
  manager.subscribe(task.taskId, event => events.push(event));
  await waitFor(() => events.some(event => event.type === "done"));
  const tool = events.find(event => event.type === "tool");
  assert.ok(tool, "expected a tool event from the fallback source");
  assert.equal(tool.data.tool, "fnos.systemInfo");
  assert.deepEqual(tool.data.result, { hostname: "nas" });
});

test("a tool that was already reported is not reported twice", async () => {
  const manager = createTaskManager({
    execute: async (_input, context) => {
      context.reportTool("fnos.listDirectory", { entries: [] });
      return { status: "completed", results: [{ tool: "fnos.listDirectory", result: { entries: [] } }] };
    }
  });
  const events = [];
  const task = manager.submit({});
  manager.subscribe(task.taskId, event => events.push(event));
  await waitFor(() => events.some(event => event.type === "done"));
  assert.equal(events.filter(event => event.type === "tool").length, 1);
});

test("a tool result never exceeds the 16 KiB result cap", async () => {
  const manager = createTaskManager({
    execute: async (_input, context) => {
      context.reportTool("fnos.readFile", { content: "x".repeat(200_000) });
      return { ok: true };
    }
  });
  const events = [];
  const task = manager.submit({});
  manager.subscribe(task.taskId, event => events.push(event));
  await waitFor(() => events.some(event => event.type === "done"));
  const tool = events.find(event => event.type === "tool");
  assert.ok(tool, "expected a tool event");
  const size = Buffer.byteLength(JSON.stringify(tool.data.result), "utf8");
  assert.ok(size <= 16 * 1024, `tool event result was ${size} bytes`);
  assert.equal(tool.data.result.truncated, true, "a cut off result must be marked");
  assert.ok(size < 200_000, "the raw tool output must not reach the stream");
});

test("a finished task emits a done event that carries the public task", async () => {
  const manager = createTaskManager({ execute: async () => ({ ok: true }) });
  const events = [];
  const task = manager.submit({});
  manager.subscribe(task.taskId, event => events.push(event));
  await waitFor(() => events.some(event => event.type === "done"));
  const done = events.find(event => event.type === "done");
  assert.equal(done.data.task.taskId, task.taskId);
  assert.equal(done.data.task.status, "completed");
  assert.equal(done.data.task.progress, 100);
});

test("a failed task ends the stream with a single error event", async () => {
  const manager = createTaskManager({
    execute: async () => { throw Object.assign(new Error("boom"), { statusCode: 400 }); }
  });
  const events = [];
  const task = manager.submit({});
  manager.subscribe(task.taskId, event => events.push(event));
  await waitFor(() => events.some(event => event.type === "error"));
  const error = events.find(event => event.type === "error");
  assert.ok(error, "expected an error event");
  assert.equal(typeof error.data.message, "string");
  assert.ok(error.data.message.length > 0);
  // The HTTP layer closes the stream on the first final event, so a failed task
  // must not send a second one.
  assert.equal(events.filter(event => event.type === "done").length, 0);
  assert.equal(events[events.length - 1].type, "error");
});

test("a task that reports a failure carries the failure reason in the error event", async () => {
  const manager = createTaskManager({
    execute: async () => ({ status: "failed", message: "模型未生成有效计划，未执行工具。" })
  });
  const events = [];
  const task = manager.submit({});
  manager.subscribe(task.taskId, event => events.push(event));
  await waitFor(() => events.some(event => event.type === "done"));
  const error = events.find(event => event.type === "error");
  assert.ok(error, "expected an error event");
  assert.equal(error.data.message, "模型未生成有效计划，未执行工具。");
  assert.equal(events.filter(event => event.type === "done").length, 0);
});

test("a task waiting for a confirmation emits an approval event", async () => {
  const manager = createTaskManager({
    execute: async () => ({ status: "awaiting-approval", message: "该操作有破坏性影响，请先确认具体目标；确认前不会执行。", pendingApproval: { approvalId: "a-1" } })
  });
  const events = [];
  const task = manager.submit({});
  manager.subscribe(task.taskId, event => events.push(event));
  await waitFor(() => events.some(event => event.type === "approval"));
  const approval = events.find(event => event.type === "approval");
  assert.equal(approval.data.task.taskId, task.taskId);
  assert.equal(approval.data.task.status, "awaiting-approval");
  assert.equal(events.some(event => event.type === "done"), false, "a pending task must not emit done");
});

test("a subscriber only receives the events of its own task", async () => {
  const manager = createTaskManager({
    execute: async (_input, context) => {
      // The stage carries the task id, so a foreign event is visible in the assertion.
      context.reportProgress(50, context.taskId);
      return { ok: true };
    }
  });
  const first = [];
  const second = [];
  const firstTask = manager.submit({});
  const secondTask = manager.submit({});
  manager.subscribe(firstTask.taskId, event => first.push(event));
  manager.subscribe(secondTask.taskId, event => second.push(event));
  await waitFor(() => first.some(event => event.type === "done") && second.some(event => event.type === "done"));
  const firstStages = first.filter(event => event.type === "progress").map(event => event.data.stage);
  const secondStages = second.filter(event => event.type === "progress").map(event => event.data.stage);
  assert.ok(firstStages.length > 0 && secondStages.length > 0);
  assert.ok(firstStages.every(stage => stage === firstTask.taskId), "the first subscriber saw a foreign event");
  assert.ok(secondStages.every(stage => stage === secondTask.taskId), "the second subscriber saw a foreign event");
});

test("unsubscribing stops the delivery and the listener is removed with the task", async () => {
  const manager = createTaskManager({
    execute: async (_input, context) => {
      context.reportProgress(20, "第一步");
      await new Promise(resolve => setTimeout(resolve, 20));
      context.reportProgress(80, "第二步");
      return { ok: true };
    }
  });
  const events = [];
  const task = manager.submit({});
  const unsubscribe = manager.subscribe(task.taskId, event => events.push(event));
  assert.equal(typeof unsubscribe, "function");
  await waitFor(() => events.some(event => event.type === "progress"));
  const before = events.length;
  unsubscribe();
  await waitFor(() => events.some(event => event.type === "done"), 120);
  assert.equal(events.length, before, "no event may arrive after unsubscribing");
  assert.equal(manager.subscriberCount(task.taskId), 0, "a finished task must not keep its listener");
});

test("a task that already finished reports its terminal state once to a new subscriber", async () => {
  const manager = createTaskManager({ execute: async () => ({ ok: true }) });
  const task = manager.submit({});
  await waitFor(() => manager.get(task.taskId)?.status === "completed");
  const events = [];
  const unsubscribe = manager.subscribe(task.taskId, event => events.push(event));
  assert.equal(typeof unsubscribe, "function");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "done");
  assert.equal(events[0].data.task.taskId, task.taskId);
});

test("the subscription limit refuses further listeners instead of throwing", async () => {
  const manager = createTaskManager({ execute: async () => new Promise(() => {}) });
  const task = manager.submit({});
  const unsubscribes = [];
  for (let i = 0; i < 32; i++) {
    const unsubscribe = manager.subscribe(task.taskId, () => {});
    assert.equal(typeof unsubscribe, "function", `listener ${i} must be accepted`);
    unsubscribes.push(unsubscribe);
  }
  assert.equal(manager.subscribe(task.taskId, () => {}), null);
  assert.equal(manager.subscribe(task.taskId, () => {}), null);
  unsubscribes.forEach(unsubscribe => unsubscribe());
});

test("an invalid subscription returns null instead of throwing", async () => {
  const manager = createTaskManager({ execute: async () => ({ ok: true }) });
  assert.equal(manager.subscribe("", () => {}), null);
  assert.equal(manager.subscribe("task-x", null), null);
  assert.equal(manager.subscribe("task-x", "not-a-function"), null);
});

test("a failing listener never breaks the task it observes", async () => {
  const manager = createTaskManager({
    execute: async (_input, context) => {
      context.reportProgress(30, "执行中");
      return { ok: true };
    }
  });
  const seen = [];
  const task = manager.submit({});
  manager.subscribe(task.taskId, () => { throw new Error("listener exploded"); });
  manager.subscribe(task.taskId, event => seen.push(event));
  await waitFor(() => seen.some(event => event.type === "done"));
  assert.equal(manager.get(task.taskId).status, "completed");
  assert.ok(seen.some(event => event.type === "done"));
});

test("the event stream never carries the task input, the prompt or a credential", async () => {
  const secret = "super-secret-token-9f2a";
  const manager = createTaskManager({
    execute: async (_input, context) => {
      // The tool event carries the tool name and its bounded result. There is no
      // channel for the tool arguments at all.
      context.reportTool("fnos.readFile", { bytes: 12, name: "a.txt" });
      return { ok: true };
    }
  });
  const events = [];
  const task = manager.submit({ text: "我的口令是 " + secret, credentials: { password: secret } });
  manager.subscribe(task.taskId, event => events.push(event));
  await waitFor(() => events.some(event => event.type === "done"));
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(secret), false, "the event stream must not carry the credential");
  assert.equal(serialized.includes("/etc/passwd"), false, "the event stream must not carry the tool arguments");
  assert.equal(serialized.includes("我的口令是"), false, "the event stream must not carry the prompt");
  const tool = events.find(event => event.type === "tool");
  assert.deepEqual(Object.keys(tool.data).sort(), ["result", "tool"]);
});

test("a resolved confirmation ends the stream with a done event", async () => {
  const manager = createTaskManager({
    execute: async () => ({ status: "awaiting-approval", pendingApproval: { approvalId: "a-1" } })
  });
  const events = [];
  const task = manager.submit({});
  manager.subscribe(task.taskId, event => events.push(event));
  await waitFor(() => events.some(event => event.type === "approval"));
  manager.resolveApproval(task.taskId, { status: "completed", result: { ok: true } });
  await waitFor(() => events.some(event => event.type === "done"));
  const done = events.find(event => event.type === "done");
  assert.equal(done.data.task.status, "completed");
  assert.equal(manager.subscriberCount(task.taskId), 0);
});

test("a cancelled task ends the stream with a done event", async () => {
  const manager = createTaskManager({
    execute: async () => ({ status: "awaiting-approval", pendingApproval: { approvalId: "a-1" } })
  });
  const events = [];
  const task = manager.submit({});
  manager.subscribe(task.taskId, event => events.push(event));
  await waitFor(() => events.some(event => event.type === "approval"));
  manager.cancel(task.taskId);
  await waitFor(() => events.some(event => event.type === "done"));
  const done = events.find(event => event.type === "done");
  assert.equal(done.data.task.status, "cancelled");
  assert.equal(manager.subscriberCount(task.taskId), 0);
});

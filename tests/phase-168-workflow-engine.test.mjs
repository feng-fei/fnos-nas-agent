import test from "node:test";
import assert from "node:assert/strict";

import {
  createWorkflowEngine,
  normalizeWorkflowDefinition,
  topologicalOrder
} from "../apps/fnos-nas-agent/app/workflow-engine.mjs";

function makeEngine(overrides = {}) {
  let counter = 0;
  return createWorkflowEngine({
    now: () => 1700000000000 + counter++,
    id: () => `run-${counter}`,
    ...overrides
  });
}

const LINEAR_WORKFLOW = {
  id: "wf-linear",
  name: "线性流程",
  steps: [
    { id: "a", tool: "collect" },
    { id: "b", tool: "analyze", dependsOn: ["a"] },
    { id: "c", tool: "report", dependsOn: ["b"] }
  ]
};

test("注册工作流返回定义并可被 listWorkflows / getWorkflow 读取", () => {
  const engine = makeEngine();
  const registered = engine.registerWorkflow(LINEAR_WORKFLOW);
  assert.equal(registered.id, "wf-linear");
  assert.equal(registered.name, "线性流程");
  assert.equal(registered.steps.length, 3);

  const list = engine.listWorkflows();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "wf-linear");
  assert.equal(list[0].stepCount, 3);

  const fetched = engine.getWorkflow("wf-linear");
  assert.equal(fetched.id, "wf-linear");
  assert.equal(engine.getWorkflow("missing"), null);
});

test("重复注册同一 workflow id 会抛错", () => {
  const engine = makeEngine();
  engine.registerWorkflow(LINEAR_WORKFLOW);
  assert.throws(() => engine.registerWorkflow(LINEAR_WORKFLOW), /already registered/);
});

test("step id 重复时拒绝注册", () => {
  const engine = makeEngine();
  assert.throws(
    () => engine.registerWorkflow({ id: "dup", steps: [{ id: "a" }, { id: "a" }] }),
    /duplicate step id/
  );
});

test("dependsOn 指向不存在的 step 时拒绝注册", () => {
  const engine = makeEngine();
  assert.throws(
    () => engine.registerWorkflow({ id: "bad-dep", steps: [{ id: "a", dependsOn: ["ghost"] }] }),
    /depends on an unknown step/
  );
});

test("依赖成环时拒绝注册", () => {
  const engine = makeEngine();
  assert.throws(
    () => engine.registerWorkflow({
      id: "cycle",
      steps: [
        { id: "a", dependsOn: ["c"] },
        { id: "b", dependsOn: ["a"] },
        { id: "c", dependsOn: ["b"] }
      ]
    }),
    /dependency cycle/
  );
  assert.throws(
    () => engine.registerWorkflow({ id: "self-cycle", steps: [{ id: "a", dependsOn: ["a"] }] }),
    /depends on itself/
  );
});

test("执行顺序遵循依赖图", async () => {
  const engine = makeEngine();
  engine.registerWorkflow(LINEAR_WORKFLOW);
  const executed = [];
  const result = await engine.runWorkflow("wf-linear", {
    invokeTool: ({ stepId }) => {
      executed.push(stepId);
    }
  });
  assert.equal(result.started, true);
  assert.equal(result.status, "completed");
  assert.deepEqual(executed, ["a", "b", "c"]);
  assert.deepEqual(result.steps.map((step) => step.id), ["a", "b", "c"]);
});

test("拓扑排序在依赖图非链式时同样稳定", () => {
  const order = topologicalOrder([
    { id: "a", dependsOn: [], order: 0 },
    { id: "b", dependsOn: ["a"], order: 1 },
    { id: "c", dependsOn: ["a"], order: 2 },
    { id: "d", dependsOn: ["b", "c"], order: 3 }
  ]);
  assert.deepEqual(order, ["a", "b", "c", "d"]);
});

test("未获批准的 step 被标记为 skipped 并记录原因", async () => {
  const engine = makeEngine();
  engine.registerWorkflow({
    id: "wf-approval",
    steps: [
      { id: "prep", tool: "collect" },
      { id: "danger", tool: "apply", dependsOn: ["prep"], approval: true },
      { id: "after", tool: "report", dependsOn: ["danger"] }
    ]
  });

  const executed = [];
  const approvals = [];
  const result = await engine.runWorkflow("wf-approval", {
    invokeTool: ({ stepId }) => {
      executed.push(stepId);
    },
    requestApproval: (request) => {
      approvals.push(request);
      return { approved: false };
    }
  });

  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].stepId, "danger");
  assert.deepEqual(executed, ["prep"]);
  assert.equal(result.status, "partial");

  const danger = result.steps.find((step) => step.id === "danger");
  assert.equal(danger.status, "skipped");
  assert.equal(danger.reason, "approval-denied");

  const after = result.steps.find((step) => step.id === "after");
  assert.equal(after.status, "skipped");
  assert.equal(after.reason, "dependency-skipped");
});

test("缺少 requestApproval 时绝不自行批准", async () => {
  const engine = makeEngine();
  engine.registerWorkflow({
    id: "wf-no-approver",
    steps: [{ id: "danger", tool: "apply", approval: true }]
  });
  const executed = [];
  const result = await engine.runWorkflow("wf-no-approver", {
    invokeTool: ({ stepId }) => {
      executed.push(stepId);
    }
  });
  assert.deepEqual(executed, []);
  assert.equal(result.steps[0].status, "skipped");
  assert.equal(result.steps[0].reason, "approval-denied");
});

test("获得批准后 step 才会执行", async () => {
  const engine = makeEngine();
  engine.registerWorkflow({
    id: "wf-approved",
    steps: [{ id: "danger", tool: "apply", approval: true }]
  });
  const executed = [];
  const result = await engine.runWorkflow("wf-approved", {
    invokeTool: ({ stepId }) => {
      executed.push(stepId);
    },
    requestApproval: () => ({ approved: true })
  });
  assert.deepEqual(executed, ["danger"]);
  assert.equal(result.status, "completed");
});

test("同一 workflowId 并发执行时第二次返回 locked", async () => {
  const engine = makeEngine();
  engine.registerWorkflow(LINEAR_WORKFLOW);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const first = engine.runWorkflow("wf-linear", {
    invokeTool: async () => {
      await gate;
    }
  });

  const second = await engine.runWorkflow("wf-linear", { invokeTool: () => {} });
  assert.equal(second.started, false);
  assert.equal(second.reason, "locked");

  release();
  const firstResult = await first;
  assert.equal(firstResult.started, true);
});

test("工具失败被记为 failed 步骤，锁随后释放，可以再次运行", async () => {
  const engine = makeEngine();
  engine.registerWorkflow({ id: "wf-boom", steps: [{ id: "a", tool: "boom" }] });
  const first = await engine.runWorkflow("wf-boom", {
    invokeTool: () => {
      throw new Error("explode");
    }
  });
  assert.equal(first.status, "failed");

  const again = await engine.runWorkflow("wf-boom", { invokeTool: () => {} });
  assert.equal(again.started, true);
});

test("引擎内部抛出未捕获异常时锁同样被释放", async () => {
  let explode = false;
  let ticks = 0;
  const engine = createWorkflowEngine({
    now: () => {
      ticks += 1;
      if (explode) throw new Error("clock exploded");
      return 1700000000000 + ticks;
    },
    id: () => "run-x"
  });
  engine.registerWorkflow({ id: "wf-clock", steps: [{ id: "a", tool: "noop" }] });
  explode = true;
  await assert.rejects(() => engine.runWorkflow("wf-clock", { invokeTool: () => {} }));

  // 锁必须已经释放：时钟恢复正常后同 id 可以再次运行
  explode = false;
  const again = await engine.runWorkflow("wf-clock", { invokeTool: () => {} });
  assert.equal(again.started, true);
  assert.equal(again.status, "completed");
});

test("失败的 step 会让依赖它的后继 step 被跳过", async () => {
  const engine = makeEngine();
  engine.registerWorkflow({
    id: "wf-fail",
    steps: [
      { id: "a", tool: "collect" },
      { id: "b", tool: "boom", dependsOn: ["a"] },
      { id: "c", tool: "report", dependsOn: ["b"] },
      { id: "d", tool: "independent" }
    ]
  });

  const executed = [];
  const result = await engine.runWorkflow("wf-fail", {
    invokeTool: ({ stepId, tool }) => {
      executed.push(stepId);
      if (tool === "boom") throw new Error("tool exploded");
    }
  });

  assert.deepEqual(executed, ["a", "b", "d"]);
  assert.equal(result.status, "failed");
  const failed = result.steps.find((step) => step.id === "b");
  assert.equal(failed.status, "failed");
  assert.match(failed.reason, /tool exploded/);
  const successor = result.steps.find((step) => step.id === "c");
  assert.equal(successor.status, "skipped");
  assert.equal(successor.reason, "dependency-failed");
});

test("通知只在 notify 为真的 step 上触发，且不携带参数原文", async () => {
  const engine = makeEngine();
  engine.registerWorkflow({
    id: "wf-notify",
    steps: [
      { id: "a", tool: "collect", args: { token: "super-secret-value" } },
      { id: "b", tool: "analyze", notify: true, args: { password: "hunter2" } }
    ]
  });

  const notifications = [];
  await engine.runWorkflow("wf-notify", {
    invokeTool: () => {},
    notify: (notification) => {
      notifications.push(notification);
    }
  });

  assert.equal(notifications.length, 1);
  const [notification] = notifications;
  assert.equal(notification.stepId, "b");
  assert.equal(notification.status, "completed");
  assert.equal(typeof notification.durationMs, "number");
  assert.deepEqual(Object.keys(notification).sort(), ["durationMs", "status", "stepId"]);
  const serialized = JSON.stringify(notification);
  assert.ok(!serialized.includes("hunter2"));
  assert.ok(!serialized.includes("super-secret-value"));
});

test("通知回调抛错不影响执行结果", async () => {
  const engine = makeEngine();
  engine.registerWorkflow({
    id: "wf-notify-throw",
    steps: [{ id: "a", tool: "collect", notify: true }]
  });
  const result = await engine.runWorkflow("wf-notify-throw", {
    invokeTool: () => {},
    notify: () => {
      throw new Error("notify failed");
    }
  });
  assert.equal(result.status, "completed");
});

test("事件列表可读且有 200 条上限", async () => {
  const engine = makeEngine();
  engine.registerWorkflow({
    id: "wf-events",
    steps: Array.from({ length: 60 }, (_, index) => ({ id: `s${index}`, tool: "noop" }))
  });
  await engine.runWorkflow("wf-events", { invokeTool: () => {} });

  const events = engine.workflowEvents("wf-events");
  assert.ok(events.length > 0);
  assert.ok(events.length <= 200);
  for (const event of events) {
    assert.equal(typeof event.at, "string");
    assert.equal(typeof event.type, "string");
    assert.equal(typeof event.message, "string");
    assert.equal(event.workflowId, "wf-events");
  }
  assert.ok(events.some((event) => event.type === "workflow.started"));
  assert.ok(events.some((event) => event.type === "workflow.finished"));
});

test("事件条数超过上限时保留最新 200 条", async () => {
  const engine = makeEngine();
  engine.registerWorkflow({
    id: "wf-events-overflow",
    steps: Array.from({ length: 250 }, (_, index) => ({ id: `s${index}`, tool: "noop" }))
  });
  await engine.runWorkflow("wf-events-overflow", { invokeTool: () => {} });
  const events = engine.workflowEvents("wf-events-overflow");
  assert.equal(events.length, 200);
  assert.equal(events[events.length - 1].type, "workflow.finished");
});

test("未知 workflow 返回 unknown-workflow", async () => {
  const engine = makeEngine();
  const result = await engine.runWorkflow("nope", {});
  assert.equal(result.started, false);
  assert.equal(result.reason, "unknown-workflow");
});

test("白名单之外的工具不会被调用", async () => {
  const engine = makeEngine({ allowedTools: ["allowed-tool"] });
  engine.registerWorkflow({
    id: "wf-allowlist",
    steps: [
      { id: "a", tool: "allowed-tool" },
      { id: "b", tool: "forbidden-tool", dependsOn: ["a"] }
    ]
  });
  const executed = [];
  const result = await engine.runWorkflow("wf-allowlist", {
    invokeTool: ({ tool }) => {
      executed.push(tool);
    }
  });
  assert.deepEqual(executed, ["allowed-tool"]);
  const forbidden = result.steps.find((step) => step.id === "b");
  assert.equal(forbidden.status, "skipped");
  assert.equal(forbidden.reason, "tool-not-allowed");
});

test("定义规范化会拒绝非法输入", () => {
  assert.throws(() => normalizeWorkflowDefinition(null), /must be an object/);
  assert.throws(() => normalizeWorkflowDefinition({ id: "" }), /workflow id is required/);
  assert.throws(() => normalizeWorkflowDefinition({ id: "x", steps: [] }), /at least one step/);
  assert.throws(() => normalizeWorkflowDefinition({ id: "x", steps: [{}] }), /requires an id/);
  assert.throws(
    () => normalizeWorkflowDefinition({ id: "x", steps: [{ id: "a", dependsOn: "b" }] }),
    /dependsOn must be an array/
  );
});

test("引擎不执行任何 shell，也不引入第三方依赖", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    new URL("../apps/fnos-nas-agent/app/workflow-engine.mjs", import.meta.url),
    "utf8"
  );
  assert.ok(!/from\s+["'][^./]/.test(source), "不得引入第三方包");
  assert.ok(!/node:child_process|execSync|spawnSync|node:http|node:fs/.test(source), "引擎不得自行执行命令或做 I/O");
});

test("注册与执行均为纯逻辑：同一份定义产生同样顺序", async () => {
  const first = makeEngine();
  const second = makeEngine();
  first.registerWorkflow(LINEAR_WORKFLOW);
  second.registerWorkflow(LINEAR_WORKFLOW);
  const orderA = [];
  const orderB = [];
  await first.runWorkflow("wf-linear", { invokeTool: ({ stepId }) => orderA.push(stepId) });
  await second.runWorkflow("wf-linear", { invokeTool: ({ stepId }) => orderB.push(stepId) });
  assert.deepEqual(orderA, orderB);
});

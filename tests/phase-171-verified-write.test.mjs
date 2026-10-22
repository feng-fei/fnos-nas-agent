import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createVerifiedWritePipeline } from "../apps/fnos-nas-agent/app/verified-write.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = join(here, "..", "apps/fnos-nas-agent/app/verified-write.mjs");

function makePipeline() {
  let tick = 0;
  return createVerifiedWritePipeline({
    now: () => {
      tick += 1;
      return 1000 + tick;
    },
    id: () => `vwp-${tick}`
  });
}

function okAction(overrides = {}) {
  return {
    id: "restart-service",
    title: "重启服务",
    risk: "write",
    preview: async () => ({ before: { running: true }, impact: ["service-a"] }),
    apply: async () => ({ restarted: true }),
    verify: async () => true,
    ...overrides
  };
}

test("四阶段按 preview → approval → apply → verify 的固定顺序执行", async () => {
  const pipeline = makePipeline();
  const order = [];
  pipeline.defineAction(
    okAction({
      preview: async () => {
        order.push("preview");
        return { before: 1 };
      },
      apply: async () => {
        order.push("apply");
        return {};
      },
      verify: async () => {
        order.push("verify");
        return true;
      }
    })
  );
  const result = await pipeline.runAction("restart-service", {
    requestApproval: async () => {
      order.push("approval");
      return true;
    },
    capability: "service.restart",
    args: { unit: "service-a" }
  });
  assert.deepEqual(order, ["preview", "approval", "apply", "verify"]);
  assert.equal(result.applied, true);
  assert.equal(result.verified, true);
  assert.equal(result.status, "completed");
  assert.equal(result.reason, null);
});

test("预演失败时整条动作终止，不进入审批与执行", async () => {
  const pipeline = makePipeline();
  let applied = false;
  let asked = false;
  pipeline.defineAction(
    okAction({
      preview: async () => {
        throw new Error("目标不存在");
      },
      apply: async () => {
        applied = true;
        return {};
      }
    })
  );
  const result = await pipeline.runAction("restart-service", {
    requestApproval: async () => {
      asked = true;
      return true;
    },
    capability: "service.restart"
  });
  assert.equal(result.applied, false);
  assert.equal(result.verified, false);
  assert.equal(result.reason, "preview-failed");
  assert.equal(asked, false);
  assert.equal(applied, false);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].stage, "preview");
  assert.equal(result.events[0].status, "failed");
  assert.equal(result.events[0].errorCategory, "preview-failed");
});

test("审批未获明确批准时终止，返回 approval-denied", async () => {
  const pipeline = makePipeline();
  let applied = false;
  pipeline.defineAction(
    okAction({
      apply: async () => {
        applied = true;
        return {};
      }
    })
  );
  const result = await pipeline.runAction("restart-service", {
    requestApproval: async () => false,
    capability: "service.restart"
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "approval-denied");
  assert.equal(applied, false);
  const approvalEvent = result.events.find(event => event.stage === "approval");
  assert.equal(approvalEvent.status, "denied");
  assert.equal(approvalEvent.errorCategory, "approval-denied");
});

test("框架不会自行批准：没有注入审批通道时动作终止", async () => {
  const pipeline = makePipeline();
  let applied = false;
  pipeline.defineAction(
    okAction({
      apply: async () => {
        applied = true;
        return {};
      }
    })
  );
  const result = await pipeline.runAction("restart-service", { capability: "service.restart" });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "approval-denied");
  assert.equal(applied, false);
});

test("传入的已批准布尔值不能绕过审批", async () => {
  const pipeline = makePipeline();
  let applied = false;
  pipeline.defineAction(
    okAction({
      apply: async () => {
        applied = true;
        return {};
      }
    })
  );
  const result = await pipeline.runAction("restart-service", {
    requestApproval: async () => undefined,
    capability: "service.restart",
    approved: true,
    preApproved: true,
    approval: true
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "approval-denied");
  assert.equal(applied, false);
});

test("缺少 capability 时失败，不会执行写操作", async () => {
  const pipeline = makePipeline();
  let applied = false;
  pipeline.defineAction(
    okAction({
      apply: async () => {
        applied = true;
        return {};
      }
    })
  );
  const result = await pipeline.runAction("restart-service", {
    requestApproval: async () => true,
    args: { unit: "service-a" }
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "capability-missing");
  assert.equal(applied, false);
  assert.equal(result.events.at(-1).errorCategory, "capability-missing");
});

test("verify 判定失败时触发回滚并如实上报", async () => {
  const pipeline = makePipeline();
  const rollbackCalls = [];
  pipeline.defineAction(
    okAction({
      verify: async () => false,
      rollback: async (args, context) => {
        rollbackCalls.push({ args, before: context.before, error: context.error });
      }
    })
  );
  const result = await pipeline.runAction("restart-service", {
    requestApproval: async () => true,
    capability: "service.restart",
    args: { unit: "service-a" }
  });
  assert.equal(result.applied, true);
  assert.equal(result.verified, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.rollbackFailed, false);
  assert.equal(result.reason, "verify-failed");
  assert.equal(rollbackCalls.length, 1);
  assert.deepEqual(rollbackCalls[0].args, { unit: "service-a" });
  assert.deepEqual(rollbackCalls[0].before, { running: true });
  assert.ok(rollbackCalls[0].error);
});

test("apply 抛错时触发回滚", async () => {
  const pipeline = makePipeline();
  let rolledBack = false;
  pipeline.defineAction(
    okAction({
      apply: async () => {
        throw new Error("写入失败");
      },
      rollback: async () => {
        rolledBack = true;
      }
    })
  );
  const result = await pipeline.runAction("restart-service", {
    requestApproval: async () => true,
    capability: "service.restart"
  });
  assert.equal(result.applied, false);
  assert.equal(result.verified, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.rollbackFailed, false);
  assert.equal(result.reason, "apply-failed");
  assert.equal(rolledBack, true);
});

test("回滚本身失败时如实上报 rollbackFailed", async () => {
  const pipeline = makePipeline();
  pipeline.defineAction(
    okAction({
      apply: async () => {
        throw new Error("写入失败");
      },
      rollback: async () => {
        throw new Error("回滚也失败");
      }
    })
  );
  const result = await pipeline.runAction("restart-service", {
    requestApproval: async () => true,
    capability: "service.restart"
  });
  assert.equal(result.applied, false);
  assert.equal(result.rolledBack, false);
  assert.equal(result.rollbackFailed, true);
  assert.equal(result.reason, "apply-failed");
  assert.equal(result.rollbackError.category, "rollback-failed");
  const rollbackEvent = result.events.find(event => event.stage === "rollback");
  assert.equal(rollbackEvent.status, "failed");
  assert.equal(rollbackEvent.errorCategory, "rollback-failed");
});

test("事件流有界，最多保留 200 条", async () => {
  const pipeline = makePipeline();
  pipeline.defineAction(okAction());
  for (let index = 0; index < 60; index += 1) {
    await pipeline.runAction("restart-service", {
      requestApproval: async () => true,
      capability: "service.restart"
    });
  }
  const events = pipeline.getEvents();
  assert.equal(events.length, 200);
  assert.ok(events.length <= 200);
});

test("事件不包含 args 原文或密钥", async () => {
  const pipeline = makePipeline();
  pipeline.defineAction(okAction());
  const result = await pipeline.runAction("restart-service", {
    requestApproval: async () => true,
    capability: "service.restart",
    args: { password: "S3CRET-PASSWORD", unit: "service-a" }
  });
  const serialized = JSON.stringify(result.events);
  assert.equal(serialized.includes("S3CRET-PASSWORD"), false);
  assert.equal(serialized.includes("service-a"), false);
  for (const event of result.events) {
    assert.deepEqual(Object.keys(event).sort(), ["durationMs", "errorCategory", "stage", "status"]);
    assert.equal(typeof event.stage, "string");
    assert.equal(typeof event.status, "string");
    assert.equal(typeof event.durationMs, "number");
  }
});

test("defineAction 校验风险等级与必需阶段", () => {
  const pipeline = makePipeline();
  assert.throws(() => pipeline.defineAction(okAction({ risk: "read" })), /risk/);
  assert.throws(() => pipeline.defineAction(okAction({ risk: undefined })), /risk/);
  assert.throws(() => pipeline.defineAction(okAction({ preview: undefined })), /preview/);
  assert.throws(() => pipeline.defineAction(okAction({ apply: undefined })), /apply/);
  assert.throws(() => pipeline.defineAction(okAction({ verify: undefined })), /verify/);
  assert.throws(() => pipeline.defineAction(okAction({ id: "" })), /id/);
  const action = pipeline.defineAction(okAction({ risk: "destructive" }));
  assert.equal(action.risk, "destructive");
  assert.deepEqual(pipeline.listActions(), ["restart-service"]);
});

test("审批通道抛错时按未批准处理", async () => {
  const pipeline = makePipeline();
  let applied = false;
  pipeline.defineAction(
    okAction({
      apply: async () => {
        applied = true;
        return {};
      }
    })
  );
  const result = await pipeline.runAction("restart-service", {
    requestApproval: async () => {
      throw new Error("审批服务不可用");
    },
    capability: "service.restart"
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "approval-denied");
  assert.equal(applied, false);
});

test("未注册的写路径不会执行任何阶段", async () => {
  const pipeline = makePipeline();
  const result = await pipeline.runAction("missing", { capability: "service.restart" });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "unknown-action");
});

test("模块保持纯逻辑：不引入 node:child_process / node:http / node:fs", () => {
  const source = readFileSync(modulePath, "utf8");
  assert.equal(/from\s+"node:(child_process|http|https|fs|fs\/promises)"/.test(source), false);
  assert.equal(/require\(/.test(source), false);
});

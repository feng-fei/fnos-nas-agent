import test from "node:test";
import assert from "node:assert/strict";
import { createAgentCore } from "../apps/fnos-nas-agent/app/agent-core.mjs";

test("agent core reports bounded stages through direct tool execution", async () => {
  const progress = [];
  const tools = {
    list: () => [{ id: "system.status", risk: "read-only", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    async invoke(id, args) { assert.equal(id, "system.status"); assert.deepEqual(args, {}); return { ok: true }; }
  };
  const model = { status: () => ({ enabled: false }), async plan() { throw new Error("must not call model"); } };
  const agent = createAgentCore({ tools, model, id: () => "progress-test" });
  const result = await agent.run({ text: "查看系统状态" }, { reportProgress(value, stage) { progress.push({ value, stage }); } });
  assert.equal(result.status, "completed");
  assert.ok(progress.length >= 4);
  assert.equal(progress[0].value, 5);
  assert.ok(progress.every((item, i) => Number.isInteger(item.value) && item.value >= 0 && item.value <= 100 && (i === 0 || item.value >= progress[i - 1].value)));
  assert.match(progress.at(-1).stage, /已完成工具/);
});

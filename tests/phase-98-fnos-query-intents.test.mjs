import test from "node:test";
import assert from "node:assert/strict";
import { createAgentCore } from "../apps/fnos-nas-agent/app/agent-core.mjs";

const definitions = [
  { id: "fnos.system.info", risk: "read-only", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { id: "fnos.file.usage", risk: "read-only", inputSchema: { type: "object", properties: { volumeId: { type: "integer", minimum: 1, maximum: 10000 } }, required: ["volumeId"], additionalProperties: false } },
  { id: "fnos.file.ls-dir", risk: "read-only", inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 2048 } }, required: ["path"], additionalProperties: false } },
  { id: "fnos.monitor.beep-supported", risk: "read-only", inputSchema: { type: "object", properties: {}, additionalProperties: false } }
];

function fixture() {
  const calls = [];
  const tools = {
    list: () => definitions,
    async invoke(id, args) { calls.push({ id, args }); return { command: id, ok: true }; }
  };
  const model = { status: () => ({ enabled: false }), async plan() { throw new Error("model should not be called"); } };
  return { agent: createAgentCore({ tools, model }), calls };
}

test("common fnOS system and volume queries route directly to allowlisted read-only tools", async () => {
  const f = fixture();
  const system = await f.agent.run({ text: "查看 fnOS 系统信息" });
  const usage = await f.agent.run({ text: "查看存储卷容量 12" });
  assert.equal(system.mode, "rules");
  assert.equal(system.results[0].tool, "fnos.system.info");
  assert.equal(usage.results[0].tool, "fnos.file.usage");
  assert.deepEqual(f.calls, [
    { id: "fnos.system.info", args: {} },
    { id: "fnos.file.usage", args: { volumeId: 12 } }
  ]);
});

test("common fnOS directory and capability queries use exact validated arguments", async () => {
  const f = fixture();
  const listing = await f.agent.run({ text: "列出目录分段 /vol1/photos" });
  const beep = await f.agent.run({ text: "检查蜂鸣器支持情况" });
  assert.equal(listing.results[0].tool, "fnos.file.ls-dir");
  assert.deepEqual(listing.results[0].result, { command: "fnos.file.ls-dir", ok: true });
  assert.equal(beep.results[0].tool, "fnos.monitor.beep-supported");
  assert.deepEqual(f.calls, [
    { id: "fnos.file.ls-dir", args: { path: "/vol1/photos" } },
    { id: "fnos.monitor.beep-supported", args: {} }
  ]);
});

test("invalid volume identifiers fail tool schema validation without invoking a CLI tool", async () => {
  const f = fixture();
  const result = await f.agent.run({ text: "查看存储卷容量 99999" });
  assert.equal(result.status, "failed");
  assert.deepEqual(f.calls, []);
});

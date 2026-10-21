import test from "node:test";
import assert from "node:assert/strict";
import { createAgentCore } from "../apps/fnos-nas-agent/app/agent-core.mjs";

const ids = [
  "fnos.docker.container-list", "fnos.docker.container-list-all", "fnos.docker.stats", "fnos.docker.compose-list",
  "fnos.monitor.memory", "fnos.monitor.network", "fnos.monitor.disk",
  "fnos.system.uptime", "fnos.system.trim-version", "fnos.system.kernel-version",
  "fnos.system.hostname", "fnos.system.volumes", "fnos.system.all-volumes"
];
const tools = {
  list: () => ids.map(id => ({ id, risk: "read-only", inputSchema: { type: "object", properties: {}, additionalProperties: false } }))
};
function fixture() {
  const calls = [];
  const registry = {
    ...tools,
    async invoke(id, args) { calls.push({ id, args }); return { command: id, data: { ok: true } }; }
  };
  const model = { status: () => ({ enabled: false }), async plan() { throw new Error("must not call model"); } };
  return { agent: createAgentCore({ tools: registry, model }), calls };
}

test("Docker containers, stats, and Compose questions use official read-only tools without model calls", async () => {
  const f = fixture();
  const cases = [
    ["查看 Docker 容器", "fnos.docker.container-list"],
    ["查看所有 Docker 容器", "fnos.docker.container-list-all"],
    ["查看 Docker 统计", "fnos.docker.stats"],
    ["查看 Compose 项目", "fnos.docker.compose-list"]
  ];
  for (const [text, id] of cases) {
    const result = await f.agent.run({ text });
    assert.equal(result.mode, "rules", text);
    assert.equal(result.status, "completed", text);
    assert.equal(result.results[0].tool, id, text);
  }
  assert.deepEqual(f.calls, cases.map(([, id]) => ({ id, args: {} })));
});

test("system runtime, version, volume and monitor queries use fixed read-only tools", async () => {
  const f = fixture();
  const cases = [
    ["查看内存监控", "fnos.monitor.memory"],
    ["查看网络监控", "fnos.monitor.network"],
    ["查看磁盘监控", "fnos.monitor.disk"],
    ["查看系统运行时间", "fnos.system.uptime"],
    ["查看 fnOS 版本", "fnos.system.trim-version"],
    ["查看内核版本", "fnos.system.kernel-version"],
    ["查看主机名", "fnos.system.hostname"],
    ["查看存储卷列表", "fnos.system.volumes"],
    ["查看全部存储卷信息", "fnos.system.all-volumes"]
  ];
  for (const [text, id] of cases) {
    const result = await f.agent.run({ text });
    assert.equal(result.mode, "rules", text);
    assert.equal(result.status, "completed", text);
    assert.equal(result.results[0].tool, id, text);
  }
  assert.deepEqual(f.calls, cases.map(([, id]) => ({ id, args: {} })));
});

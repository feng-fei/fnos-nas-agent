import test from "node:test";
import assert from "node:assert/strict";
import { createAgentCore } from "../apps/fnos-nas-agent/app/agent-core.mjs";

const definitions = [
  { id: "fnos.system.info", risk: "read-only", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { id: "fnos.file.usage", risk: "read-only", inputSchema: { type: "object", properties: { volumeId: { type: "integer", minimum: 1, maximum: 10000 } }, required: ["volumeId"], additionalProperties: false } },
  { id: "fnos.file.ls-dir", risk: "read-only", inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 2048 } }, required: ["path"], additionalProperties: false } },
  { id: "fnos.monitor.beep-supported", risk: "read-only", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { id: "files.search-content", risk: "read-only", inputSchema: { type: "object", properties: { path: { type: "string", maxLength: 2048 }, query: { type: "string", minLength: 1, maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["query"], additionalProperties: false } },
  { id: "files.inspect", risk: "read-only", inputSchema: { type: "object", properties: { path: { type: "string", maxLength: 2048 }, days: { type: "integer", minimum: 1, maximum: 3650 }, minBytes: { type: "integer", minimum: 0, maximum: 1000000000 }, limit: { type: "integer", minimum: 1, maximum: 20 } }, additionalProperties: false } },
  { id: "media.photos.search", risk: "read-only", inputSchema: { type: "object", properties: { path: { type: "string", maxLength: 2048 }, query: { type: "string", maxLength: 160 }, dateFrom: { type: "string", maxLength: 10 }, dateTo: { type: "string", maxLength: 10 }, category: { type: "string", enum: ["photo", "screenshot", "scan", "other"] }, hasGps: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false } },
  { id: "documents.index-status", risk: "read-only", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { id: "documents.search", risk: "read-only", inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 160 }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"], additionalProperties: false } },
  { id: "documents.index-refresh", risk: "write", inputSchema: { type: "object", properties: { force: { type: "boolean" }, maxFiles: { type: "integer", minimum: 1, maximum: 500 } }, additionalProperties: false } },
  { id: "health-checks.list", risk: "read-only", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { id: "health-checks.create", risk: "write", inputSchema: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 80 }, type: { type: "string", minLength: 1, maxLength: 20 }, intervalMinutes: { type: "integer", minimum: 5, maximum: 10080 }, enabled: { type: "boolean" } }, required: ["name","type","intervalMinutes"], additionalProperties: false } },
  { id: "health-checks.run", risk: "write", inputSchema: { type: "object", properties: { checkId: { type: "string", minLength: 1, maxLength: 36 } }, required: ["checkId"], additionalProperties: false } },
  { id: "health-checks.update", risk: "write", inputSchema: { type: "object", properties: { checkId: { type: "string", minLength: 1, maxLength: 36 }, enabled: { type: "boolean" }, intervalMinutes: { type: "integer", minimum: 5, maximum: 10080 } }, required: ["checkId"], additionalProperties: false } },
  { id: "health-checks.delete", risk: "write", inputSchema: { type: "object", properties: { checkId: { type: "string", minLength: 1, maxLength: 36 } }, required: ["checkId"], additionalProperties: false } }
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
  await assert.rejects(f.agent.run({ text: "查看存储卷容量 99999" }), { statusCode: 400 });
  assert.deepEqual(f.calls, []);
});


test("natural-language document content search routes to bounded read-only content search", async () => {
  const f = fixture();
  const result = await f.agent.run({ text: "搜索文件内容 报价" });
  assert.equal(result.mode, "rules");
  assert.equal(result.results[0].tool, "files.search-content");
  assert.deepEqual(f.calls, [{ id: "files.search-content", args: { query: "报价", limit: 30 } }]);
});


test("natural language file hygiene requests route to a bounded read-only inspection", async () => {
  const f = fixture();
  const result = await f.agent.run({ text: "巡检文件 /vol1/share" });
  assert.equal(result.mode, "rules");
  assert.equal(result.results[0].tool, "files.inspect");
  assert.deepEqual(f.calls, [{
    id: "files.inspect",
    args: { path: "/vol1/share", days: 90, minBytes: 1048576, limit: 10 }
  }]);
});


test("natural-language local knowledge base requests route to index status, refresh, and search tools", async () => {
  const f = fixture();
  const status = await f.agent.run({ text: "查看本地知识库状态" });
  const refresh = await f.agent.run({ text: "重建本地文档索引 强制" });
  const search = await f.agent.run({ text: "搜索知识库：家庭预算" });
  assert.equal(status.results[0].tool, "documents.index-status");
  assert.equal(refresh.results[0].tool, "documents.index-refresh");
  assert.deepEqual(f.calls[1].args, { force: true, maxFiles: 500 });
  assert.equal(search.results[0].tool, "documents.search");
  assert.deepEqual(f.calls[2].args, { query: "家庭预算", limit: 10 });
  assert.deepEqual(f.calls.map(item => item.id), ["documents.index-status","documents.index-refresh","documents.search"]);
});


test("natural language can create and list scheduled read-only health checks", async () => {
  const f = fixture();
  const created = await f.agent.run({ text: "创建定时巡检 存储 每 30 分钟" });
  const listed = await f.agent.run({ text: "查看定时巡检计划" });
  assert.equal(created.results[0].tool, "health-checks.create");
  assert.deepEqual(f.calls[0].args, { name: "存储定时巡检", type: "storage", intervalMinutes: 30, enabled: true });
  assert.equal(listed.results[0].tool, "health-checks.list");
  assert.deepEqual(f.calls.map(item => item.id), ["health-checks.create", "health-checks.list"]);
});


test("natural language photo queries route to local image metadata search", async () => {
  const f = fixture();
  const year = await f.agent.run({ text: "查找拍摄于2024年照片" });
  const screenshots = await f.agent.run({ text: "查找截图" });
  const gps = await f.agent.run({ text: "查找带有GPS的照片" });
  assert.equal(year.results[0].tool, "media.photos.search");
  assert.deepEqual(f.calls[0].args, { dateFrom: "2024-01-01", dateTo: "2024-12-31", limit: 30 });
  assert.equal(screenshots.results[0].tool, "media.photos.search");
  assert.deepEqual(f.calls[1].args, { category: "screenshot", limit: 30 });
  assert.equal(gps.results[0].tool, "media.photos.search");
  assert.deepEqual(f.calls[2].args, { hasGps: true, limit: 30 });
});

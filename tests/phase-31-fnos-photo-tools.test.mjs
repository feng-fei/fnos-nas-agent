import test from "node:test";
import assert from "node:assert/strict";
import { createReadOnlyToolRegistry } from "../apps/fnos-nas-agent/app/read-only-tools.mjs";

test("photo and monitor tools are published as bounded read-only capabilities", () => {
  const registry = createReadOnlyToolRegistry({ getDiagnostics: async () => ({}) });
  const tools = registry.list();
  const byId = new Map(tools.map(tool => [tool.id, tool]));
  assert.equal(byId.get("fnos.photos.folders").risk, "read-only");
  assert.equal(byId.get("fnos.monitor.beep-supported").risk, "read-only");
  assert.deepEqual(byId.get("fnos.photos.search").inputSchema.required, ["keyword"]);
  assert.equal(byId.get("fnos.photos.search").inputSchema.properties.limit.maximum, 50);
});

test("photo tools pass only validated arguments to the allowlisted CLI adapter", async () => {
  const calls = [];
  const trimCli = { runReadOnly: async (command, args) => { calls.push({ command, args }); return { command, data: [] }; } };
  const registry = createReadOnlyToolRegistry({ getDiagnostics: async () => ({}), trimCli });
  await registry.invoke("fnos.photos.folders", {});
  await registry.invoke("fnos.photos.search", { keyword: "holiday", limit: 10 });
  await assert.rejects(registry.invoke("fnos.photos.search", { keyword: "holiday", limit: 100 }), { statusCode: 400 });
  await assert.rejects(registry.invoke("fnos.photos.search", { keyword: "holiday", raw: true }), { statusCode: 400 });
  assert.deepEqual(calls, [
    { command: "photos.folders", args: {} },
    { command: "photos.search", args: { keyword: "holiday", limit: 10 } }
  ]);
});

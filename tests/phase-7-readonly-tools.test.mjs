import test from "node:test";
import assert from "node:assert/strict";
import { createReadOnlyToolRegistry } from "../apps/fnos-nas-agent/app/read-only-tools.mjs";

const snapshot = {
  collectedAt: "2026-10-21T00:00:00.000Z",
  system: { platform: "linux", nodeVersion: "v26.0.0" },
  cpu: { logicalCores: 4, loadAverage: [0.1, 0.2, 0.3] },
  memory: { totalBytes: 1000, freeBytes: 400, usedBytes: 600 },
  storage: [{ label: "root", available: true, totalBytes: 5000, freeBytes: 2000, usedBytes: 3000 }],
  network: [{ name: "eth0", addresses: [{ address: "192.0.2.1", family: "IPv4", cidr: "192.0.2.1/24" }] }],
  processes: { available: true, count: 42 }
};

test("registry exposes explicit read-only tools with closed input schemas", () => {
  const registry = createReadOnlyToolRegistry({ getDiagnostics: async () => snapshot, fileBrowser: { list: async () => ({ entries: [] }) }, fileManager: { preview: async path => ({ name: path }) } });
  const tools = registry.list();
  assert.deepEqual(tools.map(tool => tool.id), ["fnos.system.info","fnos.system.trim-version","fnos.system.kernel-version","fnos.system.hostname","fnos.system.uptime","fnos.system.all-volumes","fnos.system.volumes","fnos.file.ls","fnos.file.ls-dir","fnos.file.usage","fnos.app.list","fnos.docker.image-list","fnos.docker.stats","fnos.docker.container-list","fnos.docker.container-list-all","fnos.docker.compose-list","fnos.download.list","fnos.monitor.cpu","fnos.monitor.memory","fnos.monitor.network","fnos.monitor.disk","fnos.storage.pools","fnos.user.info","fnos.monitor.beep-supported","fnos.photos.folders","fnos.photos.search","system.status","storage.summary","system.process-summary","network.interfaces","files.list","files.preview","files.search","files.search-content","files.inspect","documents.index-status","documents.search","documents.index-refresh","health-checks.list","health-checks.create","health-checks.run","health-checks.update","health-checks.delete","files.create-folder","files.rename","files.move","files.upload","files.create-text","files.delete"]);
  assert.ok(tools.filter(tool => tool.risk === "read-only").length > 0);
  assert.deepEqual(tools.filter(tool => tool.risk === "write").map(tool => tool.id), ["documents.index-refresh", "health-checks.create", "health-checks.run", "health-checks.update", "health-checks.delete", "files.create-folder", "files.rename", "files.move", "files.upload", "files.create-text"]);
  assert.deepEqual(tools.filter(tool => tool.risk === "destructive").map(tool => tool.id), ["files.delete"]);
  assert.ok(tools.every(tool => ["read-only", "write", "destructive"].includes(tool.risk)));
  assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));
});

test("each tool returns only its scoped diagnostic data", async () => {
  const registry = createReadOnlyToolRegistry({ getDiagnostics: async () => snapshot });
  assert.deepEqual(await registry.invoke("system.status", {}), {
    collectedAt: snapshot.collectedAt, system: snapshot.system, cpu: snapshot.cpu, memory: snapshot.memory
  });
  assert.deepEqual(await registry.invoke("storage.summary", {}), {
    collectedAt: snapshot.collectedAt, storage: snapshot.storage
  });
  assert.deepEqual(await registry.invoke("network.interfaces", {}), {
    collectedAt: snapshot.collectedAt, network: snapshot.network
  });
  assert.deepEqual(await registry.invoke("system.process-summary", {}), {
    collectedAt: snapshot.collectedAt, processes: snapshot.processes
  });
});

test("registry validates per-tool arguments and rejects unknown fields", async () => {
  const registry = createReadOnlyToolRegistry({ getDiagnostics: async () => snapshot, fileBrowser: { list: async (path, limit) => ({ path, limit }) }, fileManager: { preview: async path => ({ name: path }) } });
  await assert.rejects(registry.invoke("shell.exec", {}), { statusCode: 404 });
  await assert.rejects(registry.invoke("system.status", { command: "id" }), { statusCode: 400 });
  await assert.rejects(registry.invoke("system.status", []), { statusCode: 400 });
  assert.deepEqual(await registry.invoke("files.list", { path: "/vol1", limit: 10 }), { path: "/vol1", limit: 10 });
  assert.deepEqual(await registry.invoke("files.preview", { path: "/vol1/readme.txt" }), { name: "/vol1/readme.txt" });
  await assert.rejects(registry.invoke("files.list", { path: "/vol1", command: "id" }), { statusCode: 400 });
  await assert.rejects(registry.invoke("files.list", { limit: 201 }), { statusCode: 400 });
  await assert.rejects(registry.invoke("files.preview", {}), { statusCode: 400 });
  assert.deepEqual(await registry.invoke("files.list", { path: "/vol1", limit: 10 }), { path: "/vol1", limit: 10 });
  assert.deepEqual(await registry.invoke("files.preview", { path: "/vol1/readme.txt" }), { name: "/vol1/readme.txt" });
  await assert.rejects(registry.invoke("files.list", { path: "/vol1", command: "id" }), { statusCode: 400 });
  await assert.rejects(registry.invoke("files.list", { limit: 201 }), { statusCode: 400 });
  await assert.rejects(registry.invoke("files.preview", {}), { statusCode: 400 });
});

test("registry requires a diagnostics provider", () => {
  assert.throws(() => createReadOnlyToolRegistry({}), TypeError);
});


test("content search is exposed as a bounded read-only tool", async () => {
  const registry = createReadOnlyToolRegistry({
    getDiagnostics: async () => snapshot,
    fileBrowser: {
      async searchContent(path, query, limit) { return { path, query, limit }; }
    }
  });
  const tool = registry.list().find(item => item.id === "files.search-content");
  assert.equal(tool.risk, "read-only");
  assert.equal(tool.inputSchema.properties.limit.maximum, 50);
  assert.deepEqual(await registry.invoke("files.search-content", { query: "invoice" }), {
    path: "", query: "invoice", limit: 30
  });
  await assert.rejects(registry.invoke("files.search-content", { query: "invoice", command: "id" }), { statusCode: 400 });
  await assert.rejects(registry.invoke("files.search-content", { query: "" }), { statusCode: 400 });
});


test("file inspection is read-only, schema-bounded and passes defaults", async () => {
  const registry = createReadOnlyToolRegistry({
    getDiagnostics: async () => snapshot,
    fileBrowser: { async inspect(path, days, minBytes, limit) { return { path, days, minBytes, limit }; } }
  });
  const tool = registry.list().find(item => item.id === "files.inspect");
  assert.equal(tool.risk, "read-only");
  assert.equal(tool.inputSchema.properties.limit.maximum, 20);
  assert.deepEqual(await registry.invoke("files.inspect", {}), {
    path: "", days: 90, minBytes: 1024 * 1024, limit: 10
  });
  await assert.rejects(registry.invoke("files.inspect", { command: "rm -rf /" }), { statusCode: 400 });
  await assert.rejects(registry.invoke("files.inspect", { days: 0 }), { statusCode: 400 });
});


test("local document index tools enforce schemas and route only to the local index service", async () => {
  const calls = [];
  const registry = createReadOnlyToolRegistry({
    getDiagnostics: async () => snapshot,
    documentIndex: {
      async status() { calls.push(["status"]); return { documentCount: 2 }; },
      async search(query, limit) { calls.push(["search", query, limit]); return { count: 1, results: [] }; },
      async refresh(options) { calls.push(["refresh", options]); return { documentCount: 3 }; }
    }
  });
  assert.equal((await registry.invoke("documents.index-status", {})).documentCount, 2);
  assert.equal((await registry.invoke("documents.search", { query: "合同" })).count, 1);
  assert.equal((await registry.invoke("documents.index-refresh", { force: true, maxFiles: 40 })).documentCount, 3);
  assert.deepEqual(calls, [["status"], ["search", "合同", 10], ["refresh", { force: true, maxFiles: 40 }]]);
  await assert.rejects(registry.invoke("documents.search", { query: "" }), { statusCode: 400 });
  await assert.rejects(registry.invoke("documents.index-refresh", { force: "yes" }), { statusCode: 400 });
  await assert.rejects(registry.invoke("documents.index-refresh", { maxFiles: 501 }), { statusCode: 400 });
});


test("scheduled health-check tools route to the scheduler and validate all arguments", async () => {
  const calls = [];
  const scheduler = {
    list() { calls.push(["list"]); return { checks: [] }; },
    async create(args) { calls.push(["create", args]); return { id: "a", ...args }; },
    async runNow(id) { calls.push(["run", id]); return { run: { status: "ok" } }; },
    async update(id, args) { calls.push(["update", id, args]); return { id, ...args }; },
    async remove(id) { calls.push(["delete", id]); return { deleted: true, id }; }
  };
  const registry = createReadOnlyToolRegistry({
    getDiagnostics: async () => snapshot,
    getScheduledHealthChecks: () => scheduler
  });
  assert.equal((await registry.invoke("health-checks.list", {})).checks.length, 0);
  await registry.invoke("health-checks.create", { name: "存储巡检", type: "storage", intervalMinutes: 30, enabled: true });
  await registry.invoke("health-checks.run", { checkId: "abc" });
  await registry.invoke("health-checks.update", { checkId: "abc", enabled: false });
  await registry.invoke("health-checks.delete", { checkId: "abc" });
  assert.deepEqual(calls, [
    ["list"],
    ["create", { name: "存储巡检", type: "storage", intervalMinutes: 30, enabled: true }],
    ["run", "abc"],
    ["update", "abc", { enabled: false }],
    ["delete", "abc"]
  ]);
  await assert.rejects(registry.invoke("health-checks.create", { name: "x", type: "shell", intervalMinutes: 5 }), { statusCode: 400 });
  await assert.rejects(registry.invoke("health-checks.create", { name: "x", type: "storage", intervalMinutes: 1 }), { statusCode: 400 });
  await assert.rejects(registry.invoke("health-checks.run", { checkId: "abc", command: "id" }), { statusCode: 400 });
});

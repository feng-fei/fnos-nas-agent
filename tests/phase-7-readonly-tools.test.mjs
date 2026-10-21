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
  assert.deepEqual(tools.map(tool => tool.id), ["fnos.system.info", "fnos.file.ls", "fnos.file.ls-dir", "fnos.file.usage", "fnos.app.list", "fnos.docker.image-list", "fnos.download.list", "fnos.monitor.cpu", "fnos.storage.pools", "fnos.user.info", "fnos.monitor.beep-supported", "fnos.photos.folders", "fnos.photos.search", "system.status", "storage.summary", "system.process-summary", "network.interfaces", "files.list", "files.preview"]);
  assert.ok(tools.every(tool => tool.risk === "read-only"));
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

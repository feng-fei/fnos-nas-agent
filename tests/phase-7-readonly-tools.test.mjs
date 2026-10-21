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

test("registry exposes only explicit read-only tools with closed input schemas", () => {
  const registry = createReadOnlyToolRegistry({ getDiagnostics: async () => snapshot });
  const tools = registry.list();
  assert.deepEqual(tools.map(tool => tool.id), ["system.status", "storage.summary", "network.interfaces", "system.process-summary"]);
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

test("registry rejects unknown tools and all arguments", async () => {
  const registry = createReadOnlyToolRegistry({ getDiagnostics: async () => snapshot });
  await assert.rejects(registry.invoke("shell.exec", {}), { statusCode: 404 });
  await assert.rejects(registry.invoke("system.status", { command: "id" }), { statusCode: 400 });
  await assert.rejects(registry.invoke("system.status", []), { statusCode: 400 });
});

test("registry requires a diagnostics provider", () => {
  assert.throws(() => createReadOnlyToolRegistry({}), TypeError);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createReadOnlyToolRegistry } from "../apps/fnos-nas-agent/app/read-only-tools.mjs";

test("the complete official CLI capability set exposes only documented read-only operations", async () => {
  const calls = [];
  const registry = createReadOnlyToolRegistry({
    getDiagnostics: async () => ({}),
    trimCli: {
      runReadOnly: async (command, args) => {
        calls.push({ command, args });
        return { command, data: { ok: true } };
      }
    }
  });
  const tools = registry.list().filter(tool => tool.id.startsWith("fnos."));
  const expected = [
    ["fnos.system.info", "system.info", {}],
    ["fnos.system.trim-version", "system.trim-version", {}],
    ["fnos.system.kernel-version", "system.kernel-version", {}],
    ["fnos.system.hostname", "system.host-name", {}],
    ["fnos.system.uptime", "system.uptime", {}],
    ["fnos.system.all-volumes", "system.all-vols", {}],
    ["fnos.system.volumes", "system.vols", {}],
    ["fnos.file.ls", "file.ls", { path: "/vol1" }],
    ["fnos.file.ls-dir", "file.ls-dir", { path: "/vol1/photos" }],
    ["fnos.file.usage", "file.usage", { volumeId: 1 }],
    ["fnos.app.list", "app.list", {}],
    ["fnos.docker.image-list", "docker.image.ls", {}],
    ["fnos.docker.stats", "docker.stats", {}],
    ["fnos.docker.container-list", "docker.container.ls", {}],
    ["fnos.docker.container-list-all", "docker.container.ls-all", {}],
    ["fnos.docker.compose-list", "docker.compose.ls", {}],
    ["fnos.download.list", "download.ls", {}],
    ["fnos.monitor.cpu", "monitor.cpu", {}],
    ["fnos.monitor.memory", "monitor.memory", {}],
    ["fnos.monitor.network", "monitor.net", {}],
    ["fnos.monitor.disk", "monitor.disk", {}],
    ["fnos.storage.pools", "storage.pools", {}],
    ["fnos.user.info", "user.info", {}],
    ["fnos.monitor.beep-supported", "monitor.beep-supported", {}],
    ["fnos.photos.folders", "photos.folders", {}],
    ["fnos.photos.search", "photos.search", { keyword: "family", limit: 10 }]
  ];
  assert.equal(tools.length, expected.length);
  assert.ok(tools.every(tool => tool.risk === "read-only"));
  assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));

  for (const [id, command, args] of expected) {
    const result = await registry.invoke(id, args);
    assert.equal(result.command, command);
  }
  assert.deepEqual(calls, expected.map(([, command, args]) => ({ command, args })));
});

test("the official CLI tool registry does not provide arbitrary shell or raw API access", async () => {
  const calls = [];
  const registry = createReadOnlyToolRegistry({
    getDiagnostics: async () => ({}),
    trimCli: { runReadOnly: async (...args) => { calls.push(args); return {}; } }
  });
  await assert.rejects(registry.invoke("fnos.raw", { path: "/api/admin", method: "DELETE" }), { statusCode: 404 });
  await assert.rejects(registry.invoke("fnos.system.restart", {}), { statusCode: 404 });
  await assert.rejects(registry.invoke("fnos.file.ls", { path: "/vol1", command: "rm -rf /" }), { statusCode: 400 });
  assert.equal(calls.length, 0);
});

test("read-only CLI commands remain usable after one session authorization; no confirmation hooks are added", () => {
  const ids = createReadOnlyToolRegistry({ getDiagnostics: async () => ({}) }).list()
    .filter(tool => tool.id.startsWith("fnos."));
  assert.ok(ids.length >= 10);
  assert.ok(ids.every(tool => tool.risk === "read-only"));
  assert.ok(ids.every(tool => tool.id !== "fnos.raw"));
});

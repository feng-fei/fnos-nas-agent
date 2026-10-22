import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createToolRegistry, normalizeToolId } from "../apps/fnos-nas-agent/app/tool-registry.mjs";
import { DELETE_CAPABILITY } from "../apps/fnos-nas-agent/app/execution-capability.mjs";

const appFile = name => fileURLToPath(new URL("../apps/fnos-nas-agent/app/" + name, import.meta.url));
const readApp = name => readFileSync(appFile(name), "utf8");

function mcpSource(overrides = {}) {
  const calls = [];
  return {
    calls,
    source: {
      id: "mcp",
      kind: "mcp",
      label: "MCP 工具",
      list: () => [
        { id: "mcp__nas__volume.list", title: "列出存储卷", description: "列出存储卷。", risk: "read-only", inputSchema: { type: "object", properties: {} } },
        { id: "mcp__nas__cache.clear", title: "清理缓存", description: "清理缓存。", risk: "destructive", inputSchema: { type: "object", properties: {} } }
      ],
      invoke: async (id, args, options) => {
        calls.push({ id, args, options });
        return { id, ok: true };
      },
      ...overrides
    }
  };
}

test("the bridge identifier shape survives the registry", () => {
  assert.equal(normalizeToolId("mcp__nas__volume.list"), "mcp__nas__volume.list");
  assert.equal(normalizeToolId("mcp:nas:volume.list"), "mcp:nas:volume.list");
  assert.equal(normalizeToolId("../etc/passwd"), null);
});

test("a destructive foreign tool still needs the server capability", async () => {
  const { source, calls } = mcpSource();
  const registry = createToolRegistry({ sources: [source] });
  await assert.rejects(() => registry.invoke("mcp__nas__cache.clear", {}), error => {
    assert.equal(error.statusCode, 403);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("an approved destructive foreign tool runs and the source sees the approval", async () => {
  const { source, calls } = mcpSource();
  const registry = createToolRegistry({ sources: [source] });
  const result = await registry.invoke("mcp__nas__cache.clear", {}, { capability: DELETE_CAPABILITY });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.approved, true);
});

test("a read only foreign tool runs without any approval", async () => {
  const { source, calls } = mcpSource();
  const registry = createToolRegistry({ sources: [source] });
  const result = await registry.invoke("mcp__nas__volume.list", {});
  assert.equal(result.ok, true);
  assert.equal(calls[0].options.approved, false);
});

test("the server publishes the MCP tools through the bridge", () => {
  const server = readApp("server.mjs");
  assert.match(server, /createMcpToolBridge/);
  assert.match(server, /mcpToolSource/);
  assert.match(server, /mcpBridge\.registerServer/);
  assert.match(server, /mcpManager\.entries\(\)/);
});

test("the model settings module is mounted in the page", () => {
  const html = readApp("ui/index.html");
  assert.match(html, /\/ui\/model-settings\.js/);
  assert.match(html, /\/ui\/model-settings\.css/);
  assert.match(html, /id="model-provider-wizard"/);
});

test("the page uses the field level validation and the wizard", () => {
  const pages = readApp("ui/pages.js");
  assert.match(pages, /validateProviderForm/);
  assert.match(pages, /buildProviderWizardSteps/);
  assert.match(pages, /showModelProviderFieldErrors/);
});

test("the model settings module publishes its pure helpers", () => {
  const module = readApp("ui/model-settings.js");
  assert.match(module, /window\.ModelSettings/);
  assert.match(module, /validateProviderForm/);
  assert.match(module, /renderProviderCard/);
});

#!/usr/bin/env node
// Phase 166: the stdio entry of the MCP server.
//
// The file publishes the read-only tools of the agent to any MCP client that
// speaks JSON-RPC 2.0 over stdio. A client starts it like this:
//
//   { "command": "node", "args": ["/opt/fnos-nas-agent/app/mcp-stdio-entry.mjs"] }
//
// Two rules of the product are not changed by this entry:
//   - only the read-only tools are published, the write and destructive tools
//     of the service are not visible at all;
//   - the server never approves a call. A client cannot pass an approval or a
//     capability, so the only thing it can reach is a read-only answer.
//
// The process must keep stdout clean: stdout carries the JSON-RPC frames, so
// every diagnostic goes to stderr.

import { createReadOnlyToolRegistry } from "./read-only-tools.mjs";
import { createExecutionPolicy } from "./execution-policy.mjs";
import { createMcpServer, toStdioTransport } from "./mcp-server.mjs";
import { APP_VERSION } from "./version.mjs";

const dataDir = typeof process.env.AGENT_DATA_DIR === "string" ? process.env.AGENT_DATA_DIR : "";

// The registry of the service is rebuilt here in its read-only shape. The
// official CLI is not available in this process, so the tools that need it
// answer with "not configured" instead of failing silently.
const registry = createReadOnlyToolRegistry({
  getDiagnostics: () => ({ platform: process.platform, arch: process.arch, nodeVersion: process.version }),
  fileBrowser: null,
  fileManager: null,
  documentIndex: null,
  getScheduledHealthChecks: () => null,
  trimCli: null,
  executionPolicy: createExecutionPolicy({ dataDir })
});

const catalogue = registry.list();

// The external name of a tool (files_list) is not the internal identifier
// (files.list). The map translates the name of the client back into the
// identifier of the registry.
const internalIds = new Map();
for (const tool of catalogue) {
  const external = typeof tool?.id === "string" ? tool.id.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[^A-Za-z0-9_]+/, "") : "";
  if (external) internalIds.set(external.slice(0, 64), tool.id);
}

const server = createMcpServer({
  name: "fnos-nas-agent",
  version: APP_VERSION,
  tools: catalogue,
  invoke: async (name, args) => {
    const internalId = internalIds.get(name);
    if (!internalId) throw Object.assign(new Error(`未知工具 "${name}"`), { statusCode: 404 });
    return registry.invoke(internalId, args);
  }
});

const transport = toStdioTransport(server);
transport.start();

process.on("SIGTERM", () => {
  transport.stop();
  server.close();
  process.exit(0);
});
process.on("SIGINT", () => {
  transport.stop();
  server.close();
  process.exit(0);
});

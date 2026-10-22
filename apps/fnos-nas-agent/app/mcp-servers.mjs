// Phase 148: configuration and lifecycle of the MCP servers.
//
// The configuration lives in a JSON file inside the data directory of the
// agent (`mcp-servers.json`). It is read on start, it is never written by the
// agent, and an entry is only used when it is explicitly enabled and passes
// the validation of `validateMcpServerConfig`.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createMcpClient, createMcpSource, validateMcpServerConfig } from "./mcp-client.mjs";

export const MCP_CONFIG_FILE = "mcp-servers.json";

/**
 * Parses the MCP configuration.
 *
 * A broken file never breaks the agent. The invalid entries are reported, the
 * valid ones are still used.
 *
 * @param {string} text the raw file content
 * @returns {{servers: object[], errors: {index: number, error: string}[]}}
 */
export function parseMcpConfig(text) {
  const servers = [];
  const errors = [];
  if (typeof text !== "string" || !text.trim()) return { servers, errors };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { servers, errors: [{ index: -1, error: "The MCP configuration is not valid JSON" }] };
  }
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.servers) ? parsed.servers : [];
  entries.forEach((entry, index) => {
    const result = validateMcpServerConfig(entry);
    if (result.ok) servers.push(result.server);
    else errors.push({ index, error: result.error });
  });
  const seen = new Set();
  for (const server of servers) {
    if (seen.has(server.id)) errors.push({ index: -1, error: `Duplicate MCP server id: ${server.id}` });
    seen.add(server.id);
  }
  return { servers: servers.filter(server => server.enabled), errors };
}

/**
 * Reads the MCP configuration from the data directory.
 *
 * @returns {Promise<{servers: object[], errors: {index: number, error: string}[]}>}
 */
export async function readMcpConfig(dataDir) {
  try {
    const text = await readFile(join(dataDir, MCP_CONFIG_FILE), "utf8");
    return parseMcpConfig(text);
  } catch (error) {
    if (error?.code === "ENOENT") return { servers: [], errors: [] };
    return { servers: [], errors: [{ index: -1, error: "The MCP configuration could not be read" }] };
  }
}

/**
 * Creates the manager that owns the MCP clients.
 *
 * The manager is lazy: a server process is only started when its tools are
 * needed, and a failing server never stops the built-in tools.
 */
export function createMcpManager({ servers = [], timeoutMs, spawn } = {}) {
  const clients = new Map();
  const sources = new Map();
  const errors = [];

  for (const server of servers) {
    try {
      const client = createMcpClient({ server, timeoutMs, spawn });
      clients.set(server.id, client);
    } catch (error) {
      errors.push({ id: server.id, error: error?.message || "The MCP server could not be prepared" });
    }
  }

  /**
   * Connects to every server and fills the tool cache.
   *
   * A server that does not answer is reported and skipped. The built-in tools
   * stay available in every case.
   */
  async function warmup() {
    for (const [id, client] of clients) {
      try {
        const tools = await client.listTools();
        sources.set(id, createMcpSource(client, tools));
      } catch (error) {
        errors.push({ id, error: error?.message || "The MCP server could not be reached" });
        sources.set(id, createMcpSource(client, []));
      }
    }
    return status();
  }

  async function list() {
    const tools = [];
    for (const client of clients.values()) {
      try {
        tools.push(...await client.listTools());
      } catch (error) {
        errors.push({ id: client.serverId, error: error?.message || "The MCP server could not be reached" });
      }
    }
    return tools;
  }

  function sources_() {
    return [...sources.values()].map(source => ({ id: source.id, kind: source.kind, label: source.label }));
  }

  /**
   * Every configured server with its client and its cached tool list.
   *
   * The bridge of Phase 153 needs the client to call a tool and the cached
   * tools to publish the catalogue. A server that never answered has an empty
   * tool list, it never blocks the built-in tools.
   */
  function entries_() {
    return [...clients.entries()].map(([id, client]) => {
      const source = sources.get(id);
      return { id, client, tools: source ? source.list() : [] };
    });
  }

  function status() {
    return {
      servers: [...clients.values()].map(client => client.status()),
      errors: errors.slice(-20)
    };
  }

  function stopAll() {
    for (const client of clients.values()) client.close();
  }

  return { list, sources: sources_, entries: entries_, warmup, status, stopAll, clientIds: () => [...clients.keys()] };
}

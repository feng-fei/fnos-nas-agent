import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.mjs";
import { listTools } from "./policy/registry.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "no-store", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'", "referrer-policy": "no-referrer" });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}
function authorized(req) {
  if (!config.accessToken) return true;
  return (req.headers.authorization || "") === `Bearer ${config.accessToken}`;
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { ok: true, app: "fnos-nas-agent", version: "0.1.0", mode: "skeleton", executionEnabled: false });
    if (!authorized(req)) return send(res, 401, { error: "Unauthorized" });
    if (req.method === "GET" && url.pathname === "/api/tools") return send(res, 200, { tools: listTools(), executionEnabled: false });
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, await readFile(join(here, "web", "index.html"), "utf8"), "text/html; charset=utf-8");
    return send(res, 404, { error: "Not found" });
  } catch {
    return send(res, 500, { error: "Internal server error" });
  }
});
server.listen(config.port, config.host, () => console.log(`fnos-nas-agent listening on ${config.host}:${config.port}; execution disabled`));
function shutdown() { server.close(() => process.exit(0)); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || process.env.TRIM_SERVICE_PORT || 18787);
const host = process.env.HOST || "0.0.0.0";

function reply(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/health") {
      return reply(res, 200, { ok: true, app: "fnos-nas-agent", version: "0.1.0", executionEnabled: false });
    }
    if (req.method === "GET" && url.pathname === "/") {
      return reply(res, 200, await readFile(join(root, "ui", "index.html"), "utf8"), "text/html; charset=utf-8");
    }
    return reply(res, 404, { error: "Not found" });
  } catch {
    return reply(res, 500, { error: "Internal server error" });
  }
});

server.listen(port, host, () => {
  // Never print environment variables or credentials.
  console.log("fnos-nas-agent status-only server listening on configured port");
});
function shutdown() { server.close(() => process.exit(0)); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

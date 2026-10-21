import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || process.env.TRIM_SERVICE_PORT || 18787);
const accessToken = process.env.AGENT_ACCESS_TOKEN || "";
const host = accessToken.length >= 32 ? (process.env.HOST || "0.0.0.0") : "127.0.0.1";
const sessions = new Map();
const attempts = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000;
const MAX_BODY = 4096;

function reply(res, status, body, type = "application/json; charset=utf-8", headers = {}) {
  res.writeHead(status, {
    "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin", ...headers
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}
function cookies(header = "") {
  const result = Object.create(null);
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) result[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return result;
}
function sessionFor(req) {
  const id = cookies(req.headers.cookie).nas_agent_session;
  const session = id && sessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    if (id) sessions.delete(id);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL;
  return { id, session };
}
function sameOrigin(req) {
  if (!req.headers.origin || !req.headers.host) return false;
  return req.headers.origin === (req.socket.encrypted ? "https://" : "http://") + req.headers.host;
}
async function jsonBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Payload too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid JSON"), { statusCode: 400 }); }
}
function tokenValid(candidate) {
  if (!accessToken || typeof candidate !== "string") return false;
  const a = Buffer.from(candidate), b = Buffer.from(accessToken);
  return a.length === b.length && timingSafeEqual(a, b);
}
function limited(req) {
  const key = req.socket.remoteAddress || "unknown", now = Date.now();
  let item = attempts.get(key);
  if (!item || now - item.start > 60_000) { item = { start: now, count: 0 }; attempts.set(key, item); }
  item.count++;
  return item.count > 10;
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/health")
      return reply(res, 200, { ok: true, app: "fnos-nas-agent", version: "0.2.0", executionEnabled: false, authenticationConfigured: accessToken.length >= 32 });
    if (req.method === "GET" && url.pathname === "/")
      return reply(res, 200, await readFile(join(root, "ui", "index.html"), "utf8"), "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/session")
      return reply(res, 200, { authenticated: Boolean(sessionFor(req)), setupRequired: accessToken.length < 32 });
    if (req.method === "POST" && url.pathname === "/api/session") {
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (accessToken.length < 32) return reply(res, 503, { error: "Authentication is not configured; service is loopback-only" });
      if (limited(req)) return reply(res, 429, { error: "Too many login attempts" }, "application/json; charset=utf-8", { "retry-after": "60" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      const body = await jsonBody(req);
      if (!tokenValid(body.token)) return reply(res, 401, { error: "Invalid access token" });
      const id = randomBytes(32).toString("base64url");
      sessions.set(id, { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL });
      attempts.delete(req.socket.remoteAddress || "unknown");
      return reply(res, 200, { authenticated: true }, "application/json; charset=utf-8", {
        "set-cookie": `nas_agent_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`
      });
    }
    if (req.method === "POST" && url.pathname === "/api/logout") {
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      const active = sessionFor(req);
      if (active) sessions.delete(active.id);
      return reply(res, 200, { authenticated: false }, "application/json; charset=utf-8", {
        "set-cookie": "nas_agent_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
      });
    }
    if (req.method === "GET" && url.pathname === "/api/tools") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      return reply(res, 200, { tools: [], executionEnabled: false });
    }
    return reply(res, 404, { error: "Not found" });
  } catch (error) {
    return reply(res, error.statusCode || 500, { error: error.statusCode ? error.message : "Internal server error" });
  }
});
server.listen(port, host, () => console.log(`fnos-nas-agent listening on ${host}:${port}; execution disabled`));
function shutdown() { sessions.clear(); server.close(() => process.exit(0)); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

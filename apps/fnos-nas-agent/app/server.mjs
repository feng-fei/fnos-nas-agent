import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rename, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual, createHash, scryptSync } from "node:crypto";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || process.env.TRIM_SERVICE_PORT || 18787);
const dataDir = process.env.AGENT_DATA_DIR || "";
const sessionFile = dataDir ? join(dataDir, "sessions.json") : "";
let accessToken = process.env.AGENT_ACCESS_TOKEN || "";
const sessions = new Map();
const attempts = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000;
const REMEMBER_TTL = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY = 4096;
let saveQueue = Promise.resolve();

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
function sessionKey(id) { return createHash("sha256").update(id).digest("hex"); }
function sessionFor(req) {
  const id = cookies(req.headers.cookie).nas_agent_session;
  const key = id && sessionKey(id);
  const session = key && sessions.get(key);
  if (!session || session.expiresAt <= Date.now()) {
    if (key && sessions.delete(key)) void persistSessions();
    return null;
  }
  return { key, session };
}
async function persistSessions() {
  if (!sessionFile) return;
  const snapshot = JSON.stringify([...sessions.entries()]);
  saveQueue = saveQueue.then(async () => {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const tmp = sessionFile + ".tmp";
    await writeFile(tmp, snapshot + "\n", { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, sessionFile);
  });
  return saveQueue;
}
async function loadSessions() {
  if (!sessionFile) return;
  try {
    const raw = JSON.parse(await readFile(sessionFile, "utf8"));
    if (!Array.isArray(raw)) return;
    const now = Date.now();
    for (const item of raw) {
      if (!Array.isArray(item) || typeof item[0] !== "string" || !item[1] || !Number.isFinite(item[1].expiresAt)) continue;
      if (item[1].expiresAt > now) sessions.set(item[0], { createdAt: item[1].createdAt, expiresAt: item[1].expiresAt });
    }
    if (sessions.size !== raw.length) await persistSessions();
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Session store could not be loaded; starting with no active sessions.");
  }
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
      return reply(res, 200, { ok: true, app: "fnos-nas-agent", version: "0.2.1", executionEnabled: false, authenticationConfigured: Boolean(passwordRecord) });
    if (req.method === "GET" && url.pathname === "/")
      return reply(res, 200, await readFile(join(root, "ui", "index.html"), "utf8"), "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/session")
      return reply(res, 200, { authenticated: Boolean(sessionFor(req)), setupRequired: !passwordRecord });
    if (req.method === "POST" && url.pathname === "/api/setup") {
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (passwordRecord) return reply(res, 409, { error: "Setup already completed" });
      if (limited(req)) return reply(res, 429, { error: "Too many setup attempts" }, "application/json; charset=utf-8", { "retry-after": "60" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      if (!dataDir) return reply(res, 503, { error: "App data directory is not configured" });
      const body = await jsonBody(req);
      if (typeof body.token !== "string" || body.token.length < 32 || body.token.length > 256)
        return reply(res, 400, { error: "Token must contain 32 to 256 characters" });
      const tokenPath = join(dataDir, "access-token");
      try {
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        await writeFile(tokenPath, body.token + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        if (error.code === "EEXIST") return reply(res, 409, { error: "Token file already exists; restart the app to load it" });
        return reply(res, 500, { error: "Unable to save access token securely" });
      }
      accessToken = body.token;
      attempts.delete(req.socket.remoteAddress || "unknown");
      return reply(res, 201, { configured: true });
    }
    if (req.method === "POST" && url.pathname === "/api/session") {
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!passwordRecord) return reply(res, 503, { error: "First-run setup is required" });
      if (limited(req)) return reply(res, 429, { error: "Too many login attempts" }, "application/json; charset=utf-8", { "retry-after": "60" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      const body = await jsonBody(req);
      if (!passwordValid(body.password)) return reply(res, 401, { error: "Invalid password" });
      const remember = body.remember === true;
      const ttl = remember ? REMEMBER_TTL : SESSION_TTL;
      const id = randomBytes(32).toString("base64url");
      const key = sessionKey(id);
      sessions.set(key, { createdAt: Date.now(), expiresAt: Date.now() + ttl });
      try { await persistSessions(); }
      catch {
        sessions.delete(key);
        return reply(res, 500, { error: "Unable to persist session securely" });
      }
      attempts.delete(req.socket.remoteAddress || "unknown");
      return reply(res, 200, { authenticated: true, remembered: remember }, "application/json; charset=utf-8", {
        "set-cookie": `nas_agent_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttl / 1000)}`
      });
    }
    if (req.method === "POST" && url.pathname === "/api/logout") {
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      const active = sessionFor(req);
      if (active) { sessions.delete(active.key); await persistSessions(); }
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
await loadPassword();\nawait loadSessions();
// First-run setup is available on the trusted LAN; no NAS commands or Skills execute in this version.
server.listen(port, process.env.HOST || "0.0.0.0", () => console.log(`fnos-nas-agent listening on ${process.env.HOST || "0.0.0.0"}:${port}; execution disabled`));
function shutdown() { server.close(() => process.exit(0)); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

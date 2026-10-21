import { createServer } from "node:http";
import os from "node:os";
import { statfs } from "node:fs/promises";
import { readFile, writeFile, mkdir, rename, chmod, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual, createHash, scryptSync } from "node:crypto";
import { createSkillStore, skillStates } from "./skills.mjs";
import { MAX_ARCHIVE_BYTES } from "./skill-archives.mjs";
import { createReadOnlyToolRegistry } from "./read-only-tools.mjs";
import { createModelAdapter } from "./model-adapter.mjs";
import { createAgentCore } from "./agent-core.mjs";
import { createTaskManager } from "./task-manager.mjs";
import { createFixedWindowLimiter } from "./request-limiter.mjs";
import { createAuditLogger } from "./audit-log.mjs";
import { createFileBrowser } from "./file-browser.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || process.env.TRIM_SERVICE_PORT || 18787);
const dataDir = process.env.AGENT_DATA_DIR || "";
const sessionFile = dataDir ? join(dataDir, "sessions.json") : "";
const passwordFile = dataDir ? join(dataDir, "password.json") : "";
let passwordRecord = null;
const sessions = new Map();
const authLimiter = createFixedWindowLimiter({ limit: 10, windowMs: 60_000, maxKeys: 1000 });
const MAX_SESSIONS = 1000;
const skillStore = dataDir ? createSkillStore(dataDir) : null;
const auditLogger = dataDir ? createAuditLogger({ dataDir }) : null;
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
      if (sessions.size >= MAX_SESSIONS) break;
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
async function rawBody(req, maxBytes) {
  const declared = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw Object.assign(new Error("Payload too large"), { statusCode: 413 });
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Payload too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
function passwordValid(candidate) {
  if (!passwordRecord || typeof candidate !== "string") return false;
  const actual = scryptSync(candidate, Buffer.from(passwordRecord.salt, "hex"), 64);
  const expected = Buffer.from(passwordRecord.hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function makePasswordRecord(password) {
  const salt = randomBytes(16);
  return { algorithm: "scrypt", salt: salt.toString("hex"), hash: scryptSync(password, salt, 64).toString("hex") };
}
async function loadPassword() {
  if (!passwordFile) return;
  try {
    const record = JSON.parse(await readFile(passwordFile, "utf8"));
    if (record?.algorithm === "scrypt" && /^[a-f0-9]{32}$/.test(record.salt) && /^[a-f0-9]{128}$/.test(record.hash)) passwordRecord = record;
    else console.error("Password record is invalid; setup is required.");
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Password record could not be loaded; setup is required.");
  }
}
async function diskUsage(path, label) {
  try {
    const s = await statfs(path, { bigint: true });
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { label, available: true, totalBytes: Number(total), freeBytes: Number(free), usedBytes: Number(total - free) };
  } catch {
    return { label, available: false };
  }
}
async function readOnlyDiagnostics() {
  const cpus = os.cpus();
  let processes = { available: false };
  try {
    const entries = await readdir("/proc", { withFileTypes: true });
    processes = { available: true, count: entries.filter(entry => entry.isDirectory() && /^[0-9]+$/.test(entry.name)).length };
  } catch { /* Non-Linux environments simply report process count unavailable. */ }
  const interfaces = Object.entries(os.networkInterfaces()).map(([name, entries]) => ({
    name,
    addresses: (entries || []).filter(entry => !entry.internal).map(entry => ({ address: entry.address, family: entry.family, cidr: entry.cidr }))
  })).filter(item => item.addresses.length > 0);
  const storage = [await diskUsage("/", "root")];
  if (dataDir && dataDir !== "/") storage.push(await diskUsage(dataDir, "app-data"));
  return {
    collectedAt: new Date().toISOString(),
    system: { platform: process.platform, arch: process.arch, release: os.release(), nodeVersion: process.version, uptimeSeconds: Math.floor(os.uptime()) },
    cpu: { logicalCores: cpus.length, model: cpus[0]?.model || "unknown", loadAverage: os.loadavg() },
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem(), usedBytes: os.totalmem() - os.freemem() },
    network: interfaces,
    processes,
    storage
  };
}
const readOnlyTools = createReadOnlyToolRegistry({ getDiagnostics: readOnlyDiagnostics });
const fileBrowser = createFileBrowser();
const modelAdapter = createModelAdapter();
const agentCore = createAgentCore({ tools: readOnlyTools, model: modelAdapter });
const taskManager = createTaskManager({ execute: input => agentCore.run(input), concurrency: 2, historyLimit: 50, queueLimit: 20, storageFile: dataDir ? join(dataDir, "tasks.json") : "" });

function auditRoute(pathname, method) {
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) || !pathname.startsWith("/api/") || pathname === "/api/health") return null;
  if (pathname === "/api/setup") return "setup";
  if (pathname === "/api/session") return method === "POST" ? "login" : "other_api";
  if (pathname === "/api/logout") return "logout";
  if (pathname === "/api/diagnostics") return "diagnostics";
  if (pathname === "/api/files") return "files.list";
  if (pathname === "/api/skills") return method === "GET" ? "skills.list" : method === "POST" ? "skills.register" : "other_api";
  if (pathname === "/api/skills/import") return "skills.import";
  if (/^\/api\/skills\/[a-f0-9]{24}\/transition$/.test(pathname)) return "skills.transition";
  if (pathname === "/api/agent/status") return "agent.status";
  if (pathname === "/api/agent/message") return "agent.message";
  if (pathname === "/api/tasks/status") return "tasks.status";
  if (pathname === "/api/tasks") return "tasks.list";
  if (/^\/api\/tasks\/[a-f0-9-]{8,64}\/cancel$/i.test(pathname)) return "tasks.cancel";
  if (/^\/api\/tasks\/[a-f0-9-]{8,64}$/i.test(pathname)) return "tasks.get";
  if (pathname === "/api/tools") return "tools.list";
  if (/^\/api\/tools\/[a-z][a-z0-9.-]{0,63}\/run$/.test(pathname)) return "tools.run";
  return "other_api";
}

function limited(req) { return !authLimiter.allow(req.socket.remoteAddress || "unknown"); }
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const auditRouteName = auditRoute(url.pathname, req.method);
    if (auditLogger && auditRouteName) res.once("finish", () => { void auditLogger.record({ method: req.method, route: auditRouteName, statusCode: res.statusCode }); });
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
      if (typeof body.password !== "string" || body.password.length < 10 || body.password.length > 128)
        return reply(res, 400, { error: "Password must contain 10 to 128 characters" });
      const record = makePasswordRecord(body.password);
      try {
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        await writeFile(passwordFile, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
        await chmod(passwordFile, 0o600);
      } catch (error) {
        if (error.code === "EEXIST") return reply(res, 409, { error: "Password already configured; restart the app if setup state is stale" });
        return reply(res, 500, { error: "Unable to save password securely" });
      }
      passwordRecord = record;
      authLimiter.reset(req.socket.remoteAddress || "unknown");
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
      const now = Date.now();
      for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
      if (sessions.size >= MAX_SESSIONS) return reply(res, 503, { error: "Session capacity is full; try again later." });
      const id = randomBytes(32).toString("base64url");
      const key = sessionKey(id);
      sessions.set(key, { createdAt: Date.now(), expiresAt: Date.now() + ttl });
      try { await persistSessions(); }
      catch {
        sessions.delete(key);
        return reply(res, 500, { error: "Unable to persist session securely" });
      }
      authLimiter.reset(req.socket.remoteAddress || "unknown");
      return reply(res, 200, { authenticated: true, remembered: remember }, "application/json; charset=utf-8", {
        "set-cookie": `nas_agent_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttl / 1000)}${req.socket.encrypted ? "; Secure" : ""}`
      });
    }
    if (req.method === "POST" && url.pathname === "/api/logout") {
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      const active = sessionFor(req);
      if (active) { sessions.delete(active.key); await persistSessions(); }
      return reply(res, 200, { authenticated: false }, "application/json; charset=utf-8", {
        "set-cookie": `nas_agent_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${req.socket.encrypted ? "; Secure" : ""}`
      });
    }
    if (req.method === "GET" && url.pathname === "/api/diagnostics") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      return reply(res, 200, await readOnlyDiagnostics());
    }
    if (url.pathname === "/api/skills") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (!skillStore) return reply(res, 503, { error: "App data directory is not configured" });
      if (req.method === "GET") {
        const rawLimit = Number(url.searchParams.get("limit") || 50);
        const rawOffset = Number(url.searchParams.get("offset") || 0);
        const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 50;
        const offset = Number.isInteger(rawOffset) ? Math.max(0, rawOffset) : 0;
        const state = url.searchParams.get("state") || undefined;
        if (state && !skillStates.includes(state)) return reply(res, 400, { error: "Invalid Skill state" });
        return reply(res, 200, skillStore.list({ limit, offset, state }));
      }
      if (req.method === "POST") {
        if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
        if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
          return reply(res, 415, { error: "Expected application/json" });
        const record = await skillStore.register(await jsonBody(req));
        return reply(res, 201, { skill: record, note: "Metadata only; archive upload and execution are not implemented." });
      }
      return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET, POST" });
    }
    if (url.pathname === "/api/skills/import") {
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!skillStore) return reply(res, 503, { error: "App data directory is not configured" });
      const contentType = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (contentType !== "application/zip" && contentType !== "application/octet-stream")
        return reply(res, 415, { error: "Upload a ZIP file using application/zip" });
      const name = typeof req.headers["x-skill-name"] === "string" ? req.headers["x-skill-name"].trim() : "";
      const version = typeof req.headers["x-skill-version"] === "string" ? req.headers["x-skill-version"].trim() : "";
      const sourceLabel = typeof req.headers["x-skill-source"] === "string" ? req.headers["x-skill-source"].trim() : "";
      if (!name || name.length > 100 || version.length > 40 || sourceLabel.length > 100)
        return reply(res, 400, { error: "Skill name is required; name/version/source lengths exceed limits" });
      const archiveBuffer = await rawBody(req, MAX_ARCHIVE_BYTES);
      const skill = await skillStore.importArchive({ name, version, sourceLabel }, archiveBuffer);
      return reply(res, 201, { skill, note: "Archive stored in quarantine; no extraction or execution occurred." });
    }
    const transitionMatch = url.pathname.match(/^\/api\/skills\/([a-f0-9]{24})\/transition$/);
    if (transitionMatch) {
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!skillStore) return reply(res, 503, { error: "App data directory is not configured" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      return reply(res, 200, { skill: await skillStore.transition(transitionMatch[1], await jsonBody(req)) });
    }
    if (url.pathname === "/api/agent/status") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      return reply(res, 200, agentCore.status());
    }
    if (url.pathname === "/api/agent/message") {
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      const input = await jsonBody(req);
      if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.text !== "string" || !input.text.trim() || input.text.trim().length > 2000)
        return reply(res, 400, { error: "Message must contain 1 to 2000 characters" });
      let task;
      try { task = taskManager.submit({ text: input.text.trim() }); }
      catch (error) {
        const status = Number.isInteger(error?.statusCode) && [429, 503].includes(error.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: status === 429 ? "Task queue is full; try again shortly." : status === 503 ? "Task capacity is temporarily full; try again shortly." : "Unable to accept task." }, "application/json; charset=utf-8", status === 429 ? { "retry-after": "2" } : {});
      }
      return reply(res, 202, { task });
    }
    if (url.pathname === "/api/tasks/status") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      return reply(res, 200, taskManager.stats());
    }
    if (url.pathname === "/api/tasks") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      const requested = Number(url.searchParams.get("limit") || 20);
      return reply(res, 200, { tasks: taskManager.list({ limit: Number.isFinite(requested) ? Math.trunc(requested) : 20 }) });
    }
    const cancelMatch = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]{8,64})\/cancel$/i);
    if (cancelMatch) {
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      const result = taskManager.cancel(cancelMatch[1]);
      if (!result) return reply(res, 404, { error: "Task not found" });
      if (!result.cancelled) return reply(res, 409, { error: "Only queued tasks can be cancelled", task: result.task });
      return reply(res, 200, result);
    }
    const taskMatch = url.pathname.match(new RegExp("^/api/tasks/([a-f0-9-]{8,64})$", "i"));
    if (taskMatch) {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      const task = taskManager.get(taskMatch[1]);
      return task ? reply(res, 200, { task }) : reply(res, 404, { error: "Task not found" });
    }
    if (url.pathname === "/api/tools") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (req.method === "GET") return reply(res, 200, {
        tools: readOnlyTools.list(),
        executionEnabled: false,
        readOnlyExecutionEnabled: true
      });
      return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
    }
    const toolRunMatch = url.pathname.match(/^\/api\/tools\/([a-z][a-z0-9.-]{0,63})\/run$/);
    if (toolRunMatch) {
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      const args = await jsonBody(req);
      return reply(res, 200, { tool: toolRunMatch[1], result: await readOnlyTools.invoke(toolRunMatch[1], args) });
    }
    return reply(res, 404, { error: "Not found" });
  } catch (error) {
    return reply(res, error.statusCode || 500, { error: error.statusCode ? error.message : "Internal server error" });
  }
});
await loadPassword();
await loadSessions();
if (skillStore) await skillStore.load();
await taskManager.ready;
// First-run setup is available on the trusted LAN; no NAS commands or Skills execute in this version.
server.listen(port, process.env.HOST || "0.0.0.0", () => console.log(`fnos-nas-agent listening on ${process.env.HOST || "0.0.0.0"}:${port}; execution disabled`));
function shutdown() { server.close(() => { void Promise.all([auditLogger?.flush(), taskManager.flush()]).finally(() => process.exit(0)); }); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

import { appendFile, chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ROUTES = new Set([
  "setup", "login", "logout", "diagnostics", "audit.list", "files.list", "files.manage", "files.checksum", "skills.list", "skills.register",
  "skills.import", "skills.transition", "skills.remove", "skills.install-cli", "agent.status", "agent.trim-cli-test", "agent.trim-cli-login-command", "agent.message",
  "tasks.status", "tasks.list", "tasks.cancel", "tasks.clear", "tasks.get", "actions.pending", "actions.confirm", "tools.list",
  "tools.run", "health-checks.list", "health-checks.create", "health-checks.update", "health-checks.delete", "health-checks.run", "models.presets", "models.list", "models.add", "models.update", "models.remove", "models.default", "models.test", "execution.mode", "other_api"
]);

// Audit events are written from a response "finish" listener that runs outside the
// request try/catch, so record() must never throw: an unknown route, an unsupported
// method or a malformed status code is normalized instead of crashing the process.
const FALLBACK_ROUTE = "other_api";
const FALLBACK_METHOD = "UNKNOWN";
const FALLBACK_STATUS_CODE = 500;
const OPTIONAL_FIELDS = Object.freeze(["sessionId", "toolId", "target", "risk", "requestId"]);
const MAX_OPTIONAL_LENGTH = 256;

function optionalText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_OPTIONAL_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function normalizeEvent(event, now) {
  const method = typeof event?.method === "string" ? event.method.toUpperCase() : "";
  const route = typeof event?.route === "string" ? event.route : "";
  const statusCode = event?.statusCode;
  const safeMethod = METHODS.has(method) ? method : FALLBACK_METHOD;
  const safeRoute = ROUTES.has(route) ? route : FALLBACK_ROUTE;
  const safeStatusCode = Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
    ? statusCode
    : FALLBACK_STATUS_CODE;
  const normalized = {
    at: now(),
    method: safeMethod,
    route: safeRoute,
    statusCode: safeStatusCode,
    outcome: safeStatusCode < 400 ? "success" : safeStatusCode < 500 ? "rejected" : "error"
  };
  for (const field of OPTIONAL_FIELDS) {
    const value = optionalText(event?.[field]);
    if (value !== null) normalized[field] = value;
  }
  return normalized;
}

export function createAuditLogger({ dataDir, filename = "audit.jsonl", maxBytes = 1_048_576, now = () => new Date().toISOString() } = {}) {
  if (typeof dataDir !== "string" || !dataDir) throw new TypeError("dataDir is required");
  if (typeof filename !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(filename) || filename === "." || filename === "..") throw new TypeError("Invalid audit filename");
  if (!Number.isInteger(maxBytes) || maxBytes < 128) throw new TypeError("Invalid maxBytes");
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const file = join(dataDir, filename);
  const rotated = file + ".1";
  let queue = Promise.resolve();

  async function writeEvent(line) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    try {
      const info = await stat(file);
      if (info.size + Buffer.byteLength(line) > maxBytes) {
        await rm(rotated, { force: true });
        await rename(file, rotated);
        await chmod(rotated, 0o600);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (Buffer.byteLength(line) > maxBytes) return;
    await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
    await chmod(file, 0o600);
  }

  return Object.freeze({
    record(event) {
      let line;
      try {
        line = JSON.stringify(normalizeEvent(event, now)) + "\n";
      } catch (error) {
        console.error(`[audit] Could not serialize audit event: ${error?.message || "unknown error"}`);
        return Promise.resolve();
      }
      // A failing audit write must be visible in the service log, but it must never
      // reject the caller or break the audit chain for later events.
      queue = queue.then(() => writeEvent(line)).catch(error => {
        console.error(`[audit] Could not append audit event to ${file}: ${error?.message || "unknown error"}`);
      });
      return queue;
    },
    flush() { return queue; },
    filePath() { return file; }
  });
}

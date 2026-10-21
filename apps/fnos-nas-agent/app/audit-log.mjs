import { appendFile, chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ROUTES = new Set([
  "setup", "login", "logout", "diagnostics", "audit.list", "files.list", "files.manage", "skills.list", "skills.register",
  "skills.import", "skills.transition", "skills.remove", "skills.install-cli", "agent.status", "agent.message",
  "tasks.status", "tasks.list", "tasks.cancel", "tasks.get", "actions.pending", "actions.confirm", "tools.list",
  "tools.run", "other_api"
]);

function normalizeEvent(event, now) {
  const method = typeof event?.method === "string" ? event.method.toUpperCase() : "";
  const route = typeof event?.route === "string" ? event.route : "";
  const statusCode = event?.statusCode;
  if (!METHODS.has(method)) throw new TypeError("Invalid audit method");
  if (!ROUTES.has(route)) throw new TypeError("Invalid audit route");
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) throw new TypeError("Invalid audit status");
  return {
    at: now(),
    method,
    route,
    statusCode,
    outcome: statusCode < 400 ? "success" : statusCode < 500 ? "rejected" : "error"
  };
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
      const line = JSON.stringify(normalizeEvent(event, now)) + "\n";
      queue = queue.then(() => writeEvent(line)).catch(() => {});
      return queue;
    },
    flush() { return queue; },
    filePath() { return file; }
  });
}

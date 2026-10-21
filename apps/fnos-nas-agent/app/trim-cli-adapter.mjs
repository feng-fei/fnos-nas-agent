import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { access, constants } from "node:fs/promises";

const execFile = promisify(execFileCallback);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;

const COMMANDS = Object.freeze({
  "system.info": { args: () => ["system", "info"] },
  "file.ls": { args: input => ["file", "ls", input.path] },
  "file.ls-dir": { args: input => ["file", "ls-dir", input.path] },
  "file.usage": { args: input => ["file", "usage", String(input.volumeId)] },
  "app.list": { args: () => ["app", "list"] },
  "docker.image.ls": { args: () => ["docker", "image", "ls"] },
  "download.ls": { args: () => ["download", "ls"] },
  "monitor.cpu": { args: () => ["monitor", "cpu"] },
  "storage.pools": { args: () => ["storage", "pools"] },
  "user.info": { args: () => ["user", "info"] }
});

function validateInput(id, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("Invalid trim-cli tool arguments"), { statusCode: 400 });
  const allowed = new Set(["file.ls", "file.ls-dir", "file.usage"]);
  if (!allowed.has(id) && Object.keys(input).length) throw Object.assign(new Error("This trim-cli tool accepts no arguments"), { statusCode: 400 });
  if (allowed.has(id)) {
    const keys = id === "file.usage" ? ["volumeId"] : ["path"];
    if (Object.keys(input).some(key => !keys.includes(key))) throw Object.assign(new Error("Unknown trim-cli tool argument"), { statusCode: 400 });
    if (id === "file.usage") {
      if (!Number.isSafeInteger(input.volumeId) || input.volumeId < 1 || input.volumeId > 10000) throw Object.assign(new Error("volumeId must be an integer from 1 to 10000"), { statusCode: 400 });
    } else if (typeof input.path !== "string" || input.path.length < 1 || input.path.length > 2048 ||
      !/^\/vol\d+(?:\/|$)/.test(input.path) || input.path.includes("\0") || input.path.includes("\\") ||
      /(^|\/)\.{1,2}(\/|$)/.test(input.path) || /[\x01-\x1f\x7f]/.test(input.path)) {
      throw Object.assign(new Error("path must stay inside an allowed /volN storage root, contain no traversal segments, and be at most 2048 characters"), { statusCode: 400 });
    }
  }
}

export function createTrimCliAdapter({
  binaryPath = process.env.TRIM_CLI_PATH || "",
  profile = process.env.TRIM_CLI_PROFILE || "home",
  execFileImpl = execFile,
  accessImpl = access,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (typeof binaryPath !== "string" || binaryPath.length > 4096) throw new TypeError("Invalid trim-cli binary path");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new TypeError("Invalid trim-cli profile");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) throw new TypeError("Invalid trim-cli timeout");

  async function status() {
    if (!binaryPath) return { configured: false, available: false, profile, reason: "TRIM_CLI_PATH is not configured" };
    try {
      await accessImpl(binaryPath, constants.X_OK);
      return { configured: true, available: true, profile };
    } catch {
      return { configured: true, available: false, profile, reason: "Configured trim-cli executable is not accessible" };
    }
  }

  async function runReadOnly(id, input = {}) {
    const command = COMMANDS[id];
    if (!command) throw Object.assign(new Error("trim-cli command is not allowlisted"), { statusCode: 404 });
    validateInput(id, input);
    const state = await status();
    if (!state.available) throw Object.assign(new Error("Official fnOS CLI is not configured or executable"), { statusCode: 503 });
    const args = ["--profile", profile, ...command.args(input)];
    try {
      const result = await execFileImpl(binaryPath, args, {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
        windowsHide: true,
        env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }
      });
      const stdout = String(result.stdout || "").trim();
      if (!stdout) return { command: id, data: null, output: "" };
      let data;
      try { data = JSON.parse(stdout); }
      catch { data = stdout.slice(0, 64_000); }
      return { command: id, data };
    } catch (error) {
      // Do not return stderr: CLI errors can accidentally include sensitive session details.
      const timedOut = error?.code === "ETIMEDOUT" || error?.killed;
      throw Object.assign(new Error(timedOut ? "trim-cli request timed out" : "trim-cli request failed; sensitive CLI output was suppressed"), {
        statusCode: timedOut ? 504 : 502,
        code: timedOut ? "TRIM_CLI_TIMEOUT" : "TRIM_CLI_FAILED"
      });
    }
  }

  return Object.freeze({ status, runReadOnly, commands: Object.freeze(Object.keys(COMMANDS)) });
}

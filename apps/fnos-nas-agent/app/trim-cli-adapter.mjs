import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { classifyTrimCliFailure, createTrimCliConnectionHealth } from "./trim-cli-health.mjs";

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
  "user.info": { args: () => ["user", "info"] },
  "monitor.beep-supported": { args: () => ["monitor", "beep-supported"] },
  "photos.folders": { args: () => ["photos", "folders"] },
  "photos.search": { args: input => ["photos", "search", input.keyword, "--limit", String(input.limit ?? 20)] }
});

function validateInput(id, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("Invalid trim-cli tool arguments"), { statusCode: 400 });
  const allowed = new Set(["file.ls", "file.ls-dir", "file.usage", "photos.search"]);
  if (!allowed.has(id) && Object.keys(input).length) throw Object.assign(new Error("This trim-cli tool accepts no arguments"), { statusCode: 400 });
  if (id === "photos.search") {
    if (Object.keys(input).some(key => !["keyword", "limit"].includes(key)) || typeof input.keyword !== "string" || input.keyword.trim().length < 1 || input.keyword.length > 200 || (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50))) throw Object.assign(new Error("photos.search requires a keyword up to 200 characters and an optional limit from 1 to 50"), { statusCode: 400 });
  }
  if (allowed.has(id) && id !== "photos.search") {
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
  binaryPathProvider = null,
  profile = process.env.TRIM_CLI_PROFILE || "home",
  execFileImpl = execFile,
  accessImpl = access,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now()
} = {}) {
  if (typeof binaryPath !== "string" || binaryPath.length > 4096) throw new TypeError("Invalid trim-cli binary path");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new TypeError("Invalid trim-cli profile");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) throw new TypeError("Invalid trim-cli timeout");

  const health = createTrimCliConnectionHealth({ now });

  async function resolveBinaryPath() {
    const candidate = typeof binaryPathProvider === "function" ? await binaryPathProvider() : binaryPath;
    if (typeof candidate !== "string" || candidate.length > 4096) return "";
    return candidate;
  }

  async function statusFor(path) {
    if (!path) return { configured: false, available: false, profile, reason: "TRIM_CLI_PATH is not configured and no enabled Skill CLI is installed" };
    try {
      await accessImpl(path, constants.X_OK);
      return { configured: true, available: true, profile };
    } catch {
      return { configured: true, available: false, profile, reason: "Configured trim-cli executable is not accessible" };
    }
  }

  async function status() {
    const state = await statusFor(await resolveBinaryPath());
    return { ...state, ...health.snapshot(state.available) };
  }

  async function setupInfo() {
    const executable = await resolveBinaryPath();
    const state = await statusFor(executable);
    const privateDataDir = typeof env.AGENT_DATA_DIR === "string" ? env.AGENT_DATA_DIR : "";
    return {
      ...state,
      ...health.snapshot(state.available),
      binaryPath: executable || "",
      dataDirConfigured: Boolean(privateDataDir),
      dataDir: privateDataDir,
      configDir: privateDataDir ? join(privateDataDir, ".config") : "",
      profile
    };
  }

  async function runReadOnly(id, input = {}) {
    const command = COMMANDS[id];
    if (!command) throw Object.assign(new Error("trim-cli command is not allowlisted"), { statusCode: 404 });
    validateInput(id, input);
    const executable = await resolveBinaryPath();
    const state = await statusFor(executable);
    if (!state.available) {
      const failure = classifyTrimCliFailure(Object.assign(new Error("Official fnOS CLI is not configured or executable"), { code: "TRIM_CLI_UNAVAILABLE" }));
      health.failure(failure);
      throw Object.assign(new Error(failure.message), { statusCode: failure.statusCode, code: "TRIM_CLI_" + failure.kind.toUpperCase(), errorCategory: failure.kind, connectionStatus: failure.connectionStatus, authenticated: failure.authenticated, nextAction: failure.nextAction });
    }
    const args = ["--profile", profile, ...command.args(input)];
    try {
      const result = await execFileImpl(executable, args, {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
        windowsHide: true,
        env: {
          PATH: env.PATH || "/usr/bin:/bin",
          HOME: env.AGENT_DATA_DIR || env.HOME || "/tmp",
          XDG_CONFIG_HOME: env.AGENT_DATA_DIR ? join(env.AGENT_DATA_DIR, ".config") : (env.XDG_CONFIG_HOME || ""),
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8"
        }
      });
      const stdout = String(result.stdout || "").trim();
      if (!stdout) return { command: id, data: null, output: "" };
      let data;
      try { data = JSON.parse(stdout); }
      catch { data = stdout.slice(0, 64_000); }
      health.success(id);
      return { command: id, data };
    } catch (error) {
      // The classifier only reads CLI diagnostics to assign a category; raw stderr/stdout is never exposed.
      const failure = classifyTrimCliFailure(error);
      health.failure(failure);
      throw Object.assign(new Error(failure.message), {
        statusCode: failure.statusCode,
        code: "TRIM_CLI_" + failure.kind.toUpperCase(),
        errorCategory: failure.kind,
        connectionStatus: failure.connectionStatus,
        authenticated: failure.authenticated,
        nextAction: failure.nextAction
      });
    }
  }

  return Object.freeze({ status, setupInfo, runReadOnly, connectionHealth: () => health.snapshot(), commands: Object.freeze(Object.keys(COMMANDS)) });
}

import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

/**
 * Global execution modes.
 *
 *   normal    - read-only and write tools run; destructive tools need a server-side
 *               approval capability.
 *   read-only - only read-only tools run; every mutating tool is refused.
 *   halted    - kill switch: nothing runs at all, not even reads.
 */
export const EXECUTION_MODES = Object.freeze(["normal", "read-only", "halted"]);

const RISK_LEVELS = new Set(["read-only", "write", "destructive"]);
const MODE_ENV_KEY = "AGENT_EXECUTION_MODE";
const STATE_FILE_NAME = "execution-mode.json";

function verdict(allowed, reason, requiresApproval, statusCode) {
  return Object.freeze({ allowed, reason, requiresApproval, statusCode });
}

/**
 * Creates the global execution policy.
 *
 * Mode resolution priority (highest first):
 *   1. state file  <dataDir>/execution-mode.json  -> {"mode":"read-only","updatedAt":"<ISO>"}
 *   2. environment variable AGENT_EXECUTION_MODE
 *   3. default "normal"
 *
 * A missing, malformed or unsupported state file is ignored with a single
 * console.warn line and the next priority is used; nothing throws.
 */
export function createExecutionPolicy({ dataDir = "", env = process.env, now = () => Date.now() } = {}) {
  let state = { mode: "normal", source: "default" };
  let sequence = 0;

  function environmentState() {
    const raw = typeof env?.[MODE_ENV_KEY] === "string" ? env[MODE_ENV_KEY].trim().toLowerCase() : "";
    if (!raw) return null;
    if (!EXECUTION_MODES.includes(raw)) {
      console.warn(`[execution-policy] Ignoring unsupported ${MODE_ENV_KEY}; expected one of ${EXECUTION_MODES.join(", ")}`);
      return null;
    }
    return { mode: raw, source: "environment" };
  }

  async function stateFileState() {
    if (!dataDir) return null;
    let raw;
    try {
      raw = await readFile(join(resolve(dataDir), STATE_FILE_NAME), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
      console.warn(`[execution-policy] Ignoring unreadable ${STATE_FILE_NAME} (${error?.code || "unknown error"})`);
      return null;
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const mode = parsed && typeof parsed.mode === "string" ? parsed.mode.trim().toLowerCase() : "";
    if (!EXECUTION_MODES.includes(mode)) {
      console.warn(`[execution-policy] Ignoring ${STATE_FILE_NAME} with an unsupported mode`);
      return null;
    }
    return { mode, source: "state-file" };
  }

  async function reload() {
    // A newer reload always wins, so a slow background load cannot overwrite a
    // mode that was just written through setMode().
    const ticket = ++sequence;
    const fromFile = await stateFileState();
    const next = fromFile ?? environmentState() ?? { mode: "normal", source: "default" };
    if (ticket === sequence) state = next;
    return { mode: state.mode, source: state.source };
  }

  function evaluate({ risk, approved } = {}) {
    if (typeof risk !== "string" || !RISK_LEVELS.has(risk))
      return verdict(false, "unknown-risk", false, 403);
    if (state.mode === "halted")
      return verdict(false, "kill-switch", false, 503);
    if (state.mode === "read-only") {
      if (risk === "read-only") return verdict(true, "allowed", false, 200);
      return verdict(false, "read-only-mode", false, 403);
    }
    if (risk === "read-only" || risk === "write")
      return verdict(true, "allowed", false, 200);
    return approved === true
      ? verdict(true, "allowed", false, 200)
      : verdict(false, "approval-required", true, 409);
  }

  /**
   * Persists the execution mode to <dataDir>/execution-mode.json (temporary file
   * first, then rename; 0600 permissions) and reloads the in-memory state.
   *
   * The mode argument is validated synchronously, so an unknown mode throws a
   * TypeError immediately. The returned promise resolves with
   * `{ mode, source: "state-file" }`. A missing data directory rejects.
   */
  function setMode(mode) {
    if (typeof mode !== "string" || !EXECUTION_MODES.includes(mode))
      throw new TypeError(`Unknown execution mode; expected one of ${EXECUTION_MODES.join(", ")}`);
    if (!dataDir) throw Object.assign(new Error("Execution state directory is not configured"), { statusCode: 500 });
    const directory = resolve(dataDir);
    const target = join(directory, STATE_FILE_NAME);
    const temporary = join(directory, `.${STATE_FILE_NAME}.${randomBytes(8).toString("hex")}.tmp`);
    const payload = `${JSON.stringify({ mode, updatedAt: new Date(now()).toISOString() })}\n`;
    return (async () => {
      try {
        await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await chmod(temporary, 0o600);
        await rename(temporary, target);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
          throw Object.assign(new Error("Execution state directory is not available"), { statusCode: 500 });
        throw error;
      }
      await reload();
      return { mode, source: "state-file" };
    })();
  }

  state = environmentState() ?? { mode: "normal", source: "default" };
  void reload().catch(() => {});

  return Object.freeze({
    mode: () => state.mode,
    source: () => state.source,
    evaluate,
    setMode,
    reload
  });
}

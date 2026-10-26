/**
 * Phase 226 — 确认式命令执行工具源（system.command）。
 *
 * 设计边界（与仓库既有安全模块对齐）：
 *   - 固定可执行文件 /bin/bash + 参数数组（["-c", command]），绝不 shell:true、
 *     绝不接受调用方提供的可执行文件路径；
 *   - 每条命令在执行前经过 command-safety-scanner（Phase 145）静态扫描：
 *     verdict "block" 直接拒绝（403 + 规则摘要），永不执行；
 *   - 本工具 risk = "destructive"：只能经 action-approval-service 的一次性
 *     人工确认后执行（confirm 时注入 DELETE_CAPABILITY，此处强校验）；
 *   - 全局执行策略（只读/停机）由 tool-registry 的既有门覆盖；
 *   - 串行执行（同一时刻至多一条）、超时 20s、输出上限、最小环境变量；
 *   - 输出只做截断，不落盘、不进审计参数。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanCommand } from "./command-safety-scanner.mjs";
import { DELETE_CAPABILITY } from "./execution-capability.mjs";

const MAX_COMMAND_CHARS = 2000;
const EXEC_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const STDOUT_KEEP_CHARS = 32 * 1024;
const STDERR_KEEP_CHARS = 8 * 1024;
const SHELL = "/bin/bash";

function fail(statusCode, message, code) {
  throw Object.assign(new Error(message), { statusCode, code });
}

function truncate(value, keep) {
  const text = typeof value === "string" ? value : "";
  return text.length > keep ? text.slice(0, keep) + "\n…（输出已截断）" : text;
}

function validateCommand(value) {
  if (typeof value !== "string") fail(400, "command must be a string", "COMMAND_INVALID");
  const command = value.trim();
  if (!command || command.length > MAX_COMMAND_CHARS) fail(400, "command must contain 1 to 2000 characters", "COMMAND_INVALID");
  if (/[\x00]/.test(command)) fail(400, "command must not contain NUL bytes", "COMMAND_INVALID");
  return command;
}

export function createCommandExecSource({
  execFileImpl = promisify(execFile),
  timeoutMs = EXEC_TIMEOUT_MS,
  dataDir = "",
  now = () => Date.now()
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000)
    throw new TypeError("Invalid command execution timeout");
  if (typeof execFileImpl !== "function") throw new TypeError("execFileImpl must be a function");

  let running = 0;

  const definition = Object.freeze({
    id: "system.command",
    title: "确认后执行系统命令",
    description: "在 NAS 上执行一条 shell 命令。执行前经静态安全扫描（高危命令直接拒绝），且必须通过一次性人工确认。",
    risk: "destructive",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", minLength: 1, maxLength: MAX_COMMAND_CHARS } },
      required: ["command"],
      additionalProperties: false
    }
  });

  const checkDefinition = Object.freeze({
    id: "system.command-check",
    title: "命令安全预检（只读）",
    description: "对一条命令做静态安全扫描，返回分级结论；不执行任何内容。",
    risk: "read-only",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", minLength: 1, maxLength: MAX_COMMAND_CHARS } },
      required: ["command"],
      additionalProperties: false
    }
  });

  function scan(command) {
    const result = scanCommand(command);
    const blocked = result.findings.filter(f => f.severity === "block");
    return {
      verdict: result.verdict,              // "block" | "warn" | "allow"
      highestSeverity: result.highestSeverity,
      blocked,
      summary: result.findings.map(f => `${f.severity}: ${f.title}`).join("；") || "未命中危险规则",
      findings: result.findings.map(({ id, severity, title, message }) => ({ id, severity, title, message }))
    };
  }

  async function invoke(toolId, args = {}, options = {}) {
    if (toolId === "system.command-check") {
      const command = validateCommand(args?.command);
      const check = scan(command);
      return { command, ok: check.verdict !== "block", check };
    }
    if (toolId !== definition.id) return { ok: false, reason: "unknown-tool" };

    // 能力门：只能由审批服务确认后注入的服务端能力令牌触发。
    if (options?.capability !== DELETE_CAPABILITY)
      fail(403, "Command execution requires a server-issued one-time approval", "COMMAND_CAPABILITY_REQUIRED");

    const command = validateCommand(args?.command);
    const { blocked } = scan(command);
    if (blocked.length)
      fail(403, "命令被安全扫描拦截，未执行：" + blocked.map(f => `${f.title}（${f.message}）`).join("；"), "COMMAND_BLOCKED");

    if (running >= 1) fail(429, "A command is already running; commands execute one at a time", "COMMAND_BUSY");
    running++;
    const started = now();
    try {
      const result = await execFileImpl(SHELL, ["-c", command], {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        cwd: "/",
        windowsHide: true,
        env: {
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          HOME: dataDir || "/tmp",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8"
        }
      });
      return {
        ok: true, exitCode: 0, timedOut: false,
        stdout: truncate(String(result.stdout || ""), STDOUT_KEEP_CHARS),
        stderr: truncate(String(result.stderr || ""), STDERR_KEEP_CHARS),
        durationMs: Math.max(0, now() - started)
      };
    } catch (error) {
      if (error && (error.killed || error.signal)) {
        return {
          ok: false, exitCode: null, timedOut: true,
          stdout: truncate(String(error.stdout || ""), STDOUT_KEEP_CHARS),
          stderr: "命令超时（" + timeoutMs + "ms），已终止。",
          durationMs: Math.max(0, now() - started)
        };
      }
      return {
        ok: false, exitCode: Number.isInteger(error?.code) ? error.code : null, timedOut: false,
        stdout: truncate(String(error?.stdout || ""), STDOUT_KEEP_CHARS),
        stderr: truncate(String(error?.stderr || ""), STDERR_KEEP_CHARS),
        durationMs: Math.max(0, now() - started)
      };
    } finally {
      running--;
    }
  }

  return Object.freeze({
    id: "command-exec",
    kind: "builtin",
    label: "确认式命令执行",
    list: () => [definition, checkDefinition],
    invoke,
    check: command => scan(validateCommand(command))
  });
}

import { createServer } from "node:http";

import os from "node:os";
import { statfs } from "node:fs/promises";
import { readFile, writeFile, mkdir, rename, chmod, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual, createHash, scrypt } from "node:crypto";
import { createSkillStore, skillStates } from "./skills.mjs";
import { MAX_ARCHIVE_BYTES } from "./skill-archives.mjs";
import { createReadOnlyToolRegistry } from "./read-only-tools.mjs";
import { createModelAdapter, modelConfiguration } from "./model-adapter.mjs";
import { createModelProviderStore } from "./model-provider-store.mjs";
import { createModelChatAdapter } from "./model-chat-adapter.mjs";
import { listModelProviderPresets } from "./model-provider-presets.mjs";
import { createAgentCore } from "./agent-core.mjs";
import { normalizeConversationHistory } from "./conversation-context.mjs";
import { createTaskManager } from "./task-manager.mjs";
import { createFixedWindowLimiter } from "./request-limiter.mjs";
import { createAuditLogger } from "./audit-log.mjs";
import { createFileBrowser } from "./file-browser.mjs";
import { createLocalDocumentIndex } from "./document-index.mjs";
import { createScheduledHealthChecks } from "./scheduled-health-checks.mjs";
import { createFileManager } from "./file-manager.mjs";
import { createTrimCliAdapter } from "./trim-cli-adapter.mjs";
import { createTrimCliLoginCommand, validateTrimCliLoginInput } from "./trim-cli-setup.mjs";
import { createSkillInstaller } from "./skill-installer.mjs";
import { fetchGitHubSkillArchive } from "./skill-remote-import.mjs";
import { importGitHubSkillBatch } from "./skill-remote-import-batch.mjs";
import { createActionApprovalService } from "./action-approval-service.mjs";
import { createSerialWriteQueue } from "./serial-write-queue.mjs";
import { createExecutionPolicy, EXECUTION_MODES } from "./execution-policy.mjs";
import { APP_VERSION } from "./version.mjs";
import { isOfficialFnosPackage } from "./skill-official-package.mjs";
import { createOverviewService } from "./overview.mjs";
import { createToolRegistry } from "./tool-registry.mjs";
import { readMcpConfig, createMcpManager } from "./mcp-servers.mjs";
import { createMcpToolBridge } from "./mcp-tool-bridge.mjs";
import { createToolTracer } from "./tool-trace.mjs";
import { createToolCallObserver } from "./tool-call-observer.mjs";
import { createStructuredLogger } from "./structured-logger.mjs";
import { buildSystemSnapshot } from "./system-snapshot.mjs";
import { buildDiagnosticReport } from "./diagnostics.mjs";
import { runSecurityInspection, buildToolPermissionTable, summarizeAuditEntries } from "./security-audit.mjs";
import { createUsageMeter, applyPrivacyMode, describeModelCapabilities } from "./model-usage.mjs";
import { createSystemCollector, buildUsageEntry } from "./agent-insights.mjs";
import { createRunbookStore } from "./runbook-store.mjs";
import { buildEvidenceBundle, collectDiagnosticEvidence } from "./diagnostic-evidence.mjs";
import { createWorkflowEngine } from "./workflow-engine.mjs";
import { createDiagnosisHistory } from "./diagnosis-history.mjs";
import { createVerifiedWritePipeline } from "./verified-write.mjs";
import { createNetworkPolicy } from "./network-policy.mjs";
import { createWebFetcher } from "./web-fetch.mjs";
import { createKnowledgeBase } from "./knowledge-base.mjs";
import { buildDockerReport } from "./docker-advisor.mjs";
import { runConnectivityPatrol } from "./network-diagnostics.mjs";
import { createDuplicateScanner } from "./duplicate-scan.mjs";
import { evaluateDeviceCapabilities, deviceEnvironment, DEVICE_PROFILES } from "./device-capability.mjs";
import { collectServiceStatus } from "./service-status.mjs";
import { createSystemctlCollector, FNOS_SERVICE_UNITS } from "./service-status-collector.mjs";
import { buildTrendVerdict } from "./capacity-forecast.mjs";
import { createCapacityHistory } from "./capacity-history.mjs";
import { planBatchRename, applyBatchRenamePlan } from "./batch-rename.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || process.env.TRIM_SERVICE_PORT || 18787);
const dataDir = process.env.AGENT_DATA_DIR || "";
const sessionFile = dataDir ? join(dataDir, "sessions.json") : "";
const passwordFile = dataDir ? join(dataDir, "password.json") : "";
const setupCodeFile = dataDir ? join(dataDir, "setup-code.txt") : "";
let setupCode = "";
let passwordRecord = null;
const sessions = new Map();
const authLimiter = createFixedWindowLimiter({ limit: 10, windowMs: 60_000, maxKeys: 1000 });
const modelActionLimiter = createFixedWindowLimiter({ limit: 10, windowMs: 60_000, maxKeys: 1000 });
const fileChecksumLimiter = createFixedWindowLimiter({ limit: 5, windowMs: 60_000, maxKeys: 1000 });
const duplicateScanLimiter = createFixedWindowLimiter({ limit: 3, windowMs: 60_000, maxKeys: 1000 });
const skillRemoteImportLimiter = createFixedWindowLimiter({ limit: 5, windowMs: 60_000, maxKeys: 1000 });
const toolRunLimiter = createFixedWindowLimiter({ limit: 30, windowMs: 60_000, maxKeys: 1000 });
const agentMessageLimiter = createFixedWindowLimiter({ limit: 20, windowMs: 60_000, maxKeys: 1000 });
// The direct chat channel is a separate route. It has its own budget, because
// a streamed answer costs far more than one plan request.
const chatMessageLimiter = createFixedWindowLimiter({ limit: 30, windowMs: 60_000, maxKeys: 1000 });
const MAX_SESSIONS = 1000;
const skillStore = dataDir ? createSkillStore(dataDir) : null;
const auditLogger = dataDir ? createAuditLogger({ dataDir }) : null;
const SESSION_TTL = 8 * 60 * 60 * 1000;
const REMEMBER_TTL = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY = 16 * 1024;
const enqueueSessionWrite = createSerialWriteQueue();

function policyMessage(decision) {
  if (decision.reason === "kill-switch") return "The agent is halted by the kill switch; no operation is accepted.";
  if (decision.reason === "read-only-mode") return "The agent is in global read-only mode; this operation is not allowed.";
  if (decision.reason === "unknown-risk") return "The operation risk could not be determined and was refused.";
  if (decision.reason === "approval-required") return "This operation needs an explicit approval before it can run.";
  return "The operation is not allowed by the current execution policy.";
}

// File operations that the file manager understands. Anything else is rejected by the
// file manager itself, so it never needs an execution policy verdict.
function fileActionRisk(action) {
  if (action === "delete") return "destructive";
  if (action === "mkdir" || action === "rename" || action === "move") return "write";
  return null;
}

function reply(res, status, body, type = "application/json; charset=utf-8", headers = {}) {
  res.writeHead(status, {
    "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin", ...headers
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}
// Reads a numeric query parameter. A value that is not a number falls back to
// the default, and the value is clamped into the allowed range.
function numberParam(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
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
    if (key && sessions.delete(key)) {
      void persistSessions().catch(() => {
        console.error("Expired session cleanup could not be persisted.");
      });
    }
    return null;
  }
  return { key, session };
}
// Loopback callers are already inside the host, so first-run setup does not need the
// installation code. Every non-loopback caller (the common LAN case) must present it.
function isLoopbackRequest(req) {
  const remote = req.socket?.remoteAddress || "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}
async function persistSessions() {
  if (!sessionFile) return;
  const snapshot = JSON.stringify([...sessions.entries()]);
  return enqueueSessionWrite(async () => {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const tmp = sessionFile + "." + randomBytes(8).toString("hex") + ".tmp";
    try {
      await writeFile(tmp, snapshot + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      await chmod(tmp, 0o600);
      await rename(tmp, sessionFile);
      await chmod(sessionFile, 0o600);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  });
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
    if (error.code === "ENOENT") return;
    // A damaged session file must not silently log every operator out without a
    // trace. The file is quarantined and the service reports the degradation.
    degradedState.sessions = true;
    console.error("Session store could not be loaded; starting with no active sessions.");
    try {
      await rename(sessionFile, sessionFile + ".corrupt-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
    } catch (renameError) {
      console.error("The damaged session store could not be quarantined:", renameError?.message || renameError);
    }
  }
}
// The agent is frequently published through the fnOS portal or another TLS
// terminating reverse proxy. The browser then talks https to the proxy while the
// agent only ever sees plain http, so the same-origin check has to compare
// against the external origin. Forwarded headers are only honoured for a
// loopback peer or when the operator opts in explicitly.
const TRUST_PROXY = process.env.AGENT_TRUST_PROXY === "1";
function isLoopbackPeer(req) {
  const remote = req.socket?.remoteAddress || "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}
function firstHeaderValue(value) {
  if (typeof value !== "string") return "";
  return value.split(",")[0].trim();
}
function externalOrigin(req) {
  const trusted = TRUST_PROXY || isLoopbackPeer(req);
  const forwardedProto = trusted ? firstHeaderValue(req.headers["x-forwarded-proto"]) : "";
  const forwardedHost = trusted ? firstHeaderValue(req.headers["x-forwarded-host"]) : "";
  const protocol = forwardedProto || (req.socket.encrypted ? "https" : "http");
  const host = forwardedHost || req.headers.host || "";
  return { origin: protocol + "://" + host, secure: protocol === "https" };
}
function sameOrigin(req) {
  if (!req.headers.origin || !req.headers.host) return false;
  return req.headers.origin === externalOrigin(req).origin;
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
  const declared = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY) throw Object.assign(new Error("Payload too large"), { statusCode: 413 });
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Payload too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid JSON"), { statusCode: 400 }); }
}
// The key derivation is asynchronous on purpose. A synchronous scrypt blocks the
// event loop for every unauthenticated caller and turns the login endpoint into
// a CPU denial of service.
function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => (error ? reject(error) : resolve(key)));
  });
}
async function passwordValid(candidate) {
  if (!passwordRecord || typeof candidate !== "string") return false;
  const actual = await deriveKey(candidate, Buffer.from(passwordRecord.salt, "hex"));
  const expected = Buffer.from(passwordRecord.hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function makePasswordRecord(password) {
  const salt = randomBytes(16);
  const hash = await deriveKey(password, salt);
  return { algorithm: "scrypt", salt: salt.toString("hex"), hash: hash.toString("hex") };
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
// First-run setup is guarded by a code that only exists on the appliance. Without it a
// host on the same LAN could claim an unconfigured instance before the owner does.
async function ensureSetupCode() {
  if (!dataDir || passwordRecord) return;
  const generated = randomBytes(12).toString("hex");
  try {
    const existing = (await readFile(setupCodeFile, "utf8")).trim();
    if (existing.length >= 8) setupCode = existing;
  } catch { /* the code is created below */ }
  if (!setupCode) {
    try {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await writeFile(setupCodeFile, generated + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      await chmod(setupCodeFile, 0o600);
      setupCode = generated;
    } catch (error) {
      if (error.code === "EEXIST") {
        const existing = (await readFile(setupCodeFile, "utf8").catch(() => "")).trim();
        setupCode = existing.length >= 8 ? existing : generated;
      } else {
        setupCode = generated;
        console.error("Setup code could not be persisted; an ephemeral setup code was generated.");
      }
    }
  }
  console.log(`fnos-nas-agent first-run setup code: ${setupCode}`);
}
function setupCodeMatches(candidate) {
  if (!setupCode) return true;
  if (typeof candidate !== "string") return false;
  const provided = Buffer.from(candidate, "utf8");
  const expected = Buffer.from(setupCode, "utf8");
  // The encoded bytes are compared, not the character count: a multi-byte
  // candidate would otherwise reach the comparison with a different length.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
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
  for (const volume of await fileManager.getRoots()) storage.push(await diskUsage(volume, basename(volume)));
  return {
    collectedAt: new Date().toISOString(),
    system: { platform: process.platform, arch: process.arch, release: os.release(), nodeVersion: process.version, uptimeSeconds: Math.floor(os.uptime()) },
    cpu: { logicalCores: cpus.length, model: cpus[0]?.model || "unknown", loadAverage: os.loadavg() },
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem(), usedBytes: os.totalmem() - os.freemem() },
    network: interfaces,
    processes,
    storage,
    degraded: degradedComponents()
  };
}
const fileBrowser = createFileBrowser();
const fileManager = createFileManager();
const duplicateScanner = createDuplicateScanner({
  listEntries: async (dir, limit) => {
    const listing = await fileBrowser.list(dir, limit, 0, "name-asc", "", "file");
    return (listing.entries || []).map((entry) => ({ path: entry.path, size: entry.sizeBytes }));
  },
  readHash: async (path) => (await fileManager.checksum(path)).sha256
});
const documentIndex = dataDir ? createLocalDocumentIndex({ dataDir, fileBrowser, fileManager }) : null;
// The execution policy is the single gate for every mutating path.
const executionPolicy = createExecutionPolicy({ dataDir });
const skillInstaller = dataDir ? createSkillInstaller({ dataDir }) : null;
const trimCli = createTrimCliAdapter({
  binaryPathProvider: async () => {
    if (process.env.TRIM_CLI_PATH) return process.env.TRIM_CLI_PATH;
    if (!skillStore) return "";
    const enabled = skillStore.list({ limit: 500, state: "enabled" }).skills;
    // The official CLI is whatever the server itself reviewed as the official
    // fnOS package. The Skill name the operator typed is only a display label
    // and must never decide whether the official binary is offered.
    const official = enabled.find(item => isOfficialFnosPackage(item));
    return official ? join(dataDir, "skill-tools", official.id, "trim-cli") : "";
  }
});
let scheduledHealthChecks = null;
const readOnlyTools = createReadOnlyToolRegistry({
  getDiagnostics: readOnlyDiagnostics, fileBrowser, fileManager, documentIndex,
  getScheduledHealthChecks: () => scheduledHealthChecks, trimCli, executionPolicy
});
scheduledHealthChecks = dataDir ? createScheduledHealthChecks({
  dataDir,
  runTool: (toolId, args) => readOnlyTools.invoke(toolId, args)
}) : null;
const modelProviderStore = dataDir ? createModelProviderStore({ dataDir }) : null;
// The direct chat channel is separate from the planner. The planner returns a
// JSON plan, the chat channel streams the answer of the model token by token.
const modelChatAdapter = modelProviderStore ? createModelChatAdapter({ providerStore: modelProviderStore }) : null;
// The usage meter counts the calls of the chat channel. A record holds the
// counters and the model names only: neither the prompt nor the answer of the
// operator is ever stored.
const usageMeter = createUsageMeter({ maxEntries: 500 });
// The runbook store keeps the operating knowledge of the operator: the
// procedures that the agent may reuse. It is a plain store, it never acts.
const runbookStore = createRunbookStore(dataDir ? { dataDir } : {});
// The diagnosis history keeps the conclusions of the operator: a symptom, the
// causes that were named and the corrections that were made later. It is an
// in-process notebook, it never changes anything on the machine.
const diagnosisHistory = createDiagnosisHistory({ maxEntries: 200 });
// The verified write pipeline defines the order of a write path: preview,
// approval, apply, verify. No action is registered yet: the server refuses to
// offer a write path it cannot verify.
const verifiedWritePipeline = createVerifiedWritePipeline({});
// The network policy is closed by default: an empty allow list refuses every
// URL. The operator has to open it explicitly with AGENT_NETWORK_ALLOW_LIST.
const networkPolicy = createNetworkPolicy({
  allowList: String(process.env.AGENT_NETWORK_ALLOW_LIST || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean),
  denyList: String(process.env.AGENT_NETWORK_DENY_LIST || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean)
});
// The fetcher asks the policy before every request and before every redirect
// hop. With a closed policy it never opens a connection.
const webFetcher = createWebFetcher({ policy: networkPolicy });
// The knowledge base keeps what was verified once. Every fact it stores carries
// the time it was collected: a stored value is never reported as the current
// state, the live read always wins. It lives in memory like the diagnosis
// history, it never acts on the machine.
const knowledgeBase = createKnowledgeBase({});
// Privacy mode is a read-only report flag: it says how many cloud calls the
// meter saw. It is not a gate, the gate would have to live in the adapter.
const privacyModeEnabled = /^(1|true|on|yes)$/i.test(String(process.env.AGENT_PRIVACY_MODE || ""));

// Records one call of the chat channel in the usage meter. Only the counters
// are kept: neither the prompt nor the answer is stored.
function recordChatUsage({ messages = [], completionText = "", outcome = "ok", latencyMs = 0 } = {}) {
  try {
    const status = modelChatAdapter?.status?.() || {};
    const provider = status.providerName || status.providerId || "unknown";
    const promptText = Array.isArray(messages)
      ? messages.map(item => (typeof item?.content === "string" ? item.content : "")).join("\n")
      : "";
    const entry = buildUsageEntry({
      provider,
      model: typeof status.model === "string" ? status.model : "",
      endpoint: "",
      outcome,
      promptText,
      completionText,
      latencyMs,
      privacyMode: privacyModeEnabled
    });
    if (entry) usageMeter.record(entry);
  } catch (error) {
    // The meter is an observation, it never breaks a chat turn.
    console.error(`[usage] Could not record the model call: ${error?.message || "unknown error"}`);
  }
}
const modelAdapter = createModelAdapter({
  configProvider: () => {
    const managed = modelProviderStore?.runtimeConfig();
    return managed || modelConfiguration();
  },
  fallbackConfigProvider: () => modelProviderStore?.runtimeFallbackConfigs() || []
});
// The tool catalogue is a registry. The built-in fnOS tools are one source of
// it, an MCP server is another one. The registry keeps the origin of every
// tool visible and it applies the global execution policy to the tools of a
// foreign source as well.
const toolTracer = createToolTracer({ dataDir });
// Every tool call ends in exactly one observer record. The record holds
// metadata only: the arguments are reduced to a fingerprint, the result and the
// error message never reach it.
const toolObserver = createToolCallObserver({ trace: toolTracer, logger: createStructuredLogger({ level: "info" }) });
const mcpConfig = dataDir ? await readMcpConfig(dataDir) : { servers: [], errors: [] };
const mcpManager = createMcpManager({ servers: mcpConfig.servers, timeoutMs: 8_000 });
// The MCP servers are contacted once at start. A server that does not answer
// is reported in /api/mcp/status, it never blocks the built-in tools.
await mcpManager.warmup();
// The MCP tools are published through the bridge of Phase 153. The bridge
// gives every foreign tool a namespaced identifier, maps it to a risk level
// and keeps the approval of the product in force before the call leaves the
// process.
const mcpBridge = createMcpToolBridge({
  policy: executionPolicy,
  // No approval hook is given to the bridge on purpose. A foreign tool that is
  // not read-only has to travel through the approval queue of the product, so
  // the bridge may never approve a call on its own.
  requestApproval: null
});
for (const entry of mcpManager.entries()) {
  try { mcpBridge.registerServer({ name: entry.id, tools: entry.tools, client: entry.client }); }
  catch (error) { mcpConfig.errors.push({ id: entry.id, error: error?.message || "The MCP server could not be bridged" }); }
}
const mcpToolSource = {
  id: "mcp",
  kind: "mcp",
  label: "MCP 工具",
  // A foreign tool that is not read-only is published as destructive. The
  // product then asks the operator for a confirmation before the call, exactly
  // like a destructive action of the built-in tools.
  list: () => mcpBridge.listBridgedTools().map(tool =>
    tool.risk === "read-only" ? tool : { ...tool, risk: "destructive" }),
  invoke: (toolId, args, options) => mcpBridge.invoke(toolId, args, options)
};
const toolRegistry = createToolRegistry({
  sources: [
    {
      id: "builtin",
      kind: "builtin",
      label: "内置 fnOS 工具",
      list: () => readOnlyTools.list(),
      invoke: (toolId, args, options) => readOnlyTools.invoke(toolId, args, options)
    },
    mcpToolSource
  ],
  executionPolicy,
  tracer: toolTracer,
  observer: toolObserver
});
const actionApprovals = createActionApprovalService({ tools: toolRegistry });
// The workflow engine runs a prepared plan of read-only tools. It never
// approves anything itself: the approval and the tool execution are injected
// from the outside, and the built-in plans only use read-only tools.
const workflowEngine = createWorkflowEngine({});
registerBuiltInWorkflows(workflowEngine);

// The plans that ship with the service. Every step uses a read-only tool: a
// workflow may look at the machine, it never changes it.
function registerBuiltInWorkflows(engine) {
  const plans = [
    {
      id: "storage-health",
      name: "存储与网络体检",
      steps: [
        { id: "storage", tool: "storage.summary", args: {} },
        { id: "processes", tool: "system.process-summary", args: {}, dependsOn: ["storage"] },
        { id: "network", tool: "network.interfaces", args: {}, dependsOn: ["storage"], notify: true }
      ]
    },
    {
      id: "file-hygiene",
      name: "文件与文档卫生检查",
      steps: [
        { id: "inspect", tool: "files.inspect", args: {} },
        { id: "documents", tool: "documents.index-status", args: {}, dependsOn: ["inspect"], notify: true }
      ]
    }
  ];
  for (const plan of plans) {
    try { engine.registerWorkflow(plan); } catch { /* a duplicate plan is not fatal */ }
  }
}
// The system snapshot is collected from the official CLI and from the local
// process. The collector never decides what is healthy, it only reports what
// it could measure.
const systemCollector = createSystemCollector({ trimCli, fileManager });

// Reads systemd unit state for the fixed whitelist above. Opt out with
// FNOS_AGENT_SERVICE_COLLECTOR=off (the route then reports every unit as
// unknown, which is what "not measured" should look like).
const serviceStatusCollector = process.env.FNOS_AGENT_SERVICE_COLLECTOR === "off" ? null : createSystemctlCollector({});

// Disk usage history for the trend forecast. Samples are written next to the
// other agent data, one record per hour at most, capped at 720 records.
const capacityHistory = createCapacityHistory({ dataDir });
const MAX_TREND_DISKS = 4;
const MAX_BATCH_RENAME_APPLY = 50;

// Reads the docker inventory the advisor analyses. A read that fails leaves the
// section empty and the report says the section is unknown: a missing answer is
// never turned into a healthy one. The collector only reads, it never changes a
// container.
async function readDockerInventory() {
  if (!trimCli || typeof trimCli.runReadOnly !== "function") return {};
  const read = async id => {
    try {
      const result = await trimCli.runReadOnly(id);
      return result?.data ?? null;
    } catch {
      return null;
    }
  };
  const pickList = (data, keys) => {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    for (const key of keys) {
      if (Array.isArray(data[key])) return data[key];
    }
    return [];
  };
  const [containers, images] = await Promise.all([
    read("docker.container.ls-all"),
    read("docker.image.ls")
  ]);
  return {
    containers: pickList(containers, ["containers", "items"]),
    images: pickList(images, ["images", "items"]),
    // The allowlist has no volume or network listing, so those sections stay
    // empty and the advisor reports them as unknown instead of guessing.
    volumes: [],
    networks: [],
    // Resource samples and log lines are not collected by the read-only
    // inventory: the advisor reports those sections as unknown instead of
    // inventing a number.
    memoryLimitMb: null
  };
}

const agentCore = createAgentCore({ tools: toolRegistry, model: modelAdapter, requestApproval: action => actionApprovals.request(action) });const taskManager = createTaskManager({ execute: (input, context) => agentCore.run(input, context), concurrency: 2, historyLimit: 50, queueLimit: 20, storageFile: dataDir ? join(dataDir, "tasks.json") : "", taskTimeoutMs: taskTimeoutMsFromEnv() });

// A state file that could not be restored leaves the service running in a degraded
// state. The operator can see which part is degraded instead of guessing.
const degradedState = { sessions: false };
function degradedComponents() {
  const components = [];
  if (skillStore?.degraded?.() === true) components.push("skills");
  if (modelProviderStore?.degraded?.() === true) components.push("models");
  if (taskManager?.degraded?.() === true) components.push("tasks");
  if (degradedState.sessions) components.push("sessions");
  return components;
}

// One place describes the service health. The health endpoint and the overview
// snapshot must not drift apart.
function healthSnapshot() {
  return {
    ok: true,
    app: "fnos-nas-agent",
    version: APP_VERSION,
    executionEnabled: false,
    executionMode: executionPolicy.mode(),
    executionModeSource: executionPolicy.source(),
    degraded: degradedComponents().length > 0,
    degradedComponents: degradedComponents(),
    authenticationConfigured: Boolean(passwordRecord)
  };
}

// The mobile-first console needs every headline number in a single response
// instead of six parallel API calls.
const overviewService = createOverviewService({
  health: () => healthSnapshot(),
  executionPolicy,
  taskManager,
  skillStore,
  modelProviderStore,
  actionApprovals,
  agentCore
});

// The user interface is split into an HTML shell, one stylesheet and two
// scripts. Only a fixed set of extensions is served, and the file name may not
// contain a path segment, so the route can never escape the ui directory.
const UI_ASSET_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".webmanifest", "application/manifest+json"]
]);

async function serveUiAsset(res, url) {
  if (!url.pathname.startsWith("/ui/")) return false;
  let name = "";
  try {
    name = decodeURIComponent(url.pathname.slice("/ui/".length));
  } catch {
    return false;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) return false;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  const type = UI_ASSET_TYPES.get(name.slice(dot).toLowerCase());
  if (!type) return false;
  let body;
  try {
    // Binary assets (icons, images) must not be decoded as text.
    body = await readFile(join(root, "ui", name));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return false;
    throw error;
  }
  reply(res, 200, body, type, { "cache-control": "no-cache" });
  return true;
}

// A model request can hang for minutes; the task manager aborts it after this
// budget. 0 disables the timeout, the upper bound is one hour.
function taskTimeoutMsFromEnv() {
  const raw = process.env.AGENT_TASK_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 5 * 60 * 1000;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 60 * 60 * 1000) {
    console.error("AGENT_TASK_TIMEOUT_MS is invalid; the default of 5 minutes is used.");
    return 5 * 60 * 1000;
  }
  return parsed;
}

function auditRoute(pathname, method) {
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) || !pathname.startsWith("/api/") || pathname === "/api/health") return null;
  if (pathname === "/api/setup") return "setup";
  if (pathname === "/api/session") return method === "POST" ? "login" : "other_api";
  if (pathname === "/api/logout") return "logout";
  if (pathname === "/api/diagnostics") return "diagnostics";
  if (pathname === "/api/execution-mode") return "execution.mode";
  if (pathname === "/api/overview") return "overview";
  if (pathname === "/api/skills/transitions/batch") return "skills.transition";
  if (pathname === "/api/audit") return "audit.list";
  if (pathname === "/api/files/checksum") return "files.checksum";
  if (pathname === "/api/files/duplicates") return "files.duplicates";
  if (pathname === "/api/files/rename-plan") return "files.rename-plan";
  if (pathname === "/api/files/rename-apply") return "files.rename-apply";
  if (pathname.startsWith("/api/files")) return pathname === "/api/files" ? "files.list" : "files.manage";
  if (pathname === "/api/skills") return method === "GET" ? "skills.list" : method === "POST" ? "skills.register" : "other_api";
  if (/^\/api\/skills\/[a-f0-9]{24}\/source-files$/.test(pathname) || /^\/api\/skills\/[a-f0-9]{24}\/source-preview$/.test(pathname)) return "skills.list";
  if (/^\/api\/skills\/[a-f0-9]{24}$/.test(pathname)) return "skills.remove";
  if (pathname === "/api/skills/import" || pathname === "/api/skills/import-remote" || pathname === "/api/skills/import-remote-batch") return "skills.import";
  if (/^\/api\/skills\/[a-f0-9]{24}\/transition$/.test(pathname)) return "skills.transition";
  if (/^\/api\/skills\/([a-f0-9]{24})\/install-cli$/.test(pathname)) return "skills.install-cli";
  if (pathname === "/api/models/presets") return "models.presets";
  if (pathname === "/api/models") return method === "GET" ? "models.list" : method === "POST" ? "models.add" : "other_api";
  if (/^\/api\/models\/[a-f0-9]{24}$/.test(pathname)) return method === "PUT" ? "models.update" : method === "DELETE" ? "models.remove" : "other_api";
  if (/^\/api\/models\/[a-f0-9]{24}\/default$/.test(pathname)) return "models.default";
  if (/^\/api\/models\/[a-f0-9]{24}\/test$/.test(pathname)) return "models.test";
  if (pathname === "/api/agent/status") return "agent.status";
  if (pathname === "/api/agent/trim-cli/test") return "agent.trim-cli-test";
  if (pathname === "/api/agent/trim-cli/login-command") return "agent.trim-cli-login-command";
  if (pathname === "/api/agent/message") return "agent.message";
  if (pathname === "/api/chat/message") return "chat.message";
  if (pathname === "/api/chat/status") return "chat.status";
  if (pathname === "/api/agent/trace") return "agent.trace";
  if (pathname === "/api/mcp/status") return "mcp.status";
  if (pathname === "/api/system/snapshot") return "system.snapshot";
  if (pathname === "/api/system/capabilities") return "system.capabilities";
  if (pathname === "/api/system/services") return "system.services";
  if (pathname === "/api/system/capacity-forecast") return "system.capacity-forecast";
  if (pathname === "/api/diagnostics/report") return "diagnostics.report";
  if (pathname === "/api/diagnostics/evidence") return "diagnostics.evidence";
  if (pathname === "/api/security/inspection") return "security.inspection";
  if (pathname === "/api/models/usage") return "models.usage";
  if (pathname === "/api/workflows") return method === "GET" ? "workflows.list" : "workflows.run";
  if (pathname.startsWith("/api/workflows/")) return "workflows.events";
  if (pathname === "/api/runbooks") return method === "GET" ? "runbooks.list" : method === "POST" ? "runbooks.write" : "other_api";
  if (pathname === "/api/runbooks/stats") return "runbooks.stats";
  if (pathname.startsWith("/api/runbooks/")) return method === "DELETE" ? "runbooks.delete" : "runbooks.read";
  if (pathname === "/api/diagnoses") return "diagnoses.list";
  if (pathname === "/api/diagnoses/stats") return "diagnoses.stats";
  if (pathname.startsWith("/api/diagnoses/")) return pathname.endsWith("/corrections") ? "diagnoses.correct" : "diagnoses.read";
  if (pathname === "/api/write-actions") return "write.actions.list";
  if (pathname === "/api/network/policy") return "network.policy";
  if (pathname === "/api/network/check") return "network.check";
  if (pathname === "/api/network/diagnostics") return "network.diagnostics";
  if (pathname === "/api/web/fetch") return "web.fetch";
  if (pathname === "/api/knowledge") return "knowledge.list";
  if (pathname === "/api/knowledge/stats") return "knowledge.stats";
  if (pathname === "/api/knowledge/conflicts") return "knowledge.conflicts";
  if (pathname === "/api/knowledge/preview") return "knowledge.preview";
  if (pathname === "/api/knowledge/commit") return "knowledge.commit";
  if (pathname.startsWith("/api/knowledge/")) return pathname.endsWith("/reference") ? "knowledge.reference" : "knowledge.read";
  if (pathname === "/api/docker/advice") return "docker.advice";
  if (pathname === "/api/tasks/clear-history") return "tasks.clear";
  if (pathname === "/api/health-checks") return method === "GET" ? "health-checks.list" : method === "POST" ? "health-checks.create" : "other_api";
  if (/^\/api\/health-checks\/[a-f0-9-]{36}\/run$/i.test(pathname)) return "health-checks.run";
  if (/^\/api\/health-checks\/[a-f0-9-]{36}$/i.test(pathname)) return method === "DELETE" ? "health-checks.delete" : method === "PATCH" || method === "PUT" ? "health-checks.update" : "other_api";
  if (pathname === "/api/tasks/status") return "tasks.status";
  if (pathname === "/api/tasks") return "tasks.list";
  if (/^\/api\/tasks\/[a-f0-9-]{8,64}\/cancel$/i.test(pathname)) return "tasks.cancel";
  if (/^\/api\/tasks\/[a-f0-9-]{8,64}\/events$/i.test(pathname)) return "tasks.events";
  if (/^\/api\/tasks\/[a-f0-9-]{8,64}$/i.test(pathname)) return "tasks.get";
  if (pathname === "/api/actions/pending") return "actions.pending";
  if (/^\/api\/actions\/[a-f0-9-]{8,64}\/(?:confirm|deny)$/i.test(pathname)) return "actions.confirm";
  if (pathname === "/api/tools") return "tools.list";
  if (/^\/api\/tools\/[a-z][a-z0-9.:_-]{0,127}\/run$/.test(pathname)) return "tools.run";
  return "other_api";
}

function limited(req) { return !authLimiter.allow(req.socket.remoteAddress || "unknown"); }
// The overview snapshot is rebuilt on every call, so it carries its own budget.
const overviewLimiter = createFixedWindowLimiter({ limit: 60, windowMs: 60_000, maxKeys: 1000 });
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const auditRouteName = auditRoute(url.pathname, req.method);
    // The actor is resolved before the handler runs: a logout removes the
    // session, so the audit event would otherwise lose the actor.
    const auditedSession = sessionFor(req);
    if (auditLogger && auditRouteName) res.once("finish", () => {
      try {
        void auditLogger.record({
          method: req.method,
          route: auditRouteName,
          statusCode: res.statusCode,
          sessionId: auditedSession ? auditedSession.key : ""
        });
      }
      catch (error) { console.error("Audit record could not be queued:", error?.message || error); }
    });
    if (req.method === "GET" && url.pathname === "/api/health")
      return reply(res, 200, healthSnapshot());
    if (req.method === "GET" && url.pathname === "/api/overview") {
      const overviewSession = sessionFor(req);
      if (!overviewSession) return reply(res, 401, { error: "Unauthorized" });
      if (!overviewLimiter.allow(overviewSession.key))
        return reply(res, 429, { error: "Too many overview requests" }, "application/json; charset=utf-8", { "retry-after": "60" });
      try {
        return reply(res, 200, overviewService.snapshot());
      } catch (error) {
        console.error("Overview snapshot failed:", error?.message || error);
        return reply(res, 500, { error: "Unable to build the overview snapshot" });
      }
    }
    if (req.method === "GET" && url.pathname === "/")
      return reply(res, 200, await readFile(join(root, "ui", "index.html"), "utf8"), "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname.startsWith("/ui/")) {
      if (await serveUiAsset(res, url)) return;
      return reply(res, 404, { error: "Not found" });
    }
    if (req.method === "GET" && url.pathname === "/api/session")
      return reply(res, 200, { authenticated: Boolean(sessionFor(req)), setupRequired: !passwordRecord, setupCodeRequired: Boolean(setupCode) && !isLoopbackRequest(req) });
    if (req.method === "POST" && url.pathname === "/api/setup") {
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (passwordRecord) return reply(res, 409, { error: "Setup already completed" });
      if (limited(req)) return reply(res, 429, { error: "Too many setup attempts" }, "application/json; charset=utf-8", { "retry-after": "60" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      if (!dataDir) return reply(res, 503, { error: "App data directory is not configured" });
      const body = await jsonBody(req);
      if (setupCode && !isLoopbackRequest(req) && !setupCodeMatches(body.code))
        return reply(res, 403, { error: "Setup code is invalid", setupCodeRequired: true });
      if (typeof body.password !== "string" || body.password.length < 10 || body.password.length > 128)
        return reply(res, 400, { error: "Password must contain 10 to 128 characters" });
      const record = await makePasswordRecord(body.password);
      try {
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        await writeFile(passwordFile, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
        await chmod(passwordFile, 0o600);
      } catch (error) {
        if (error.code === "EEXIST") return reply(res, 409, { error: "Password already configured; restart the app if setup state is stale" });
        return reply(res, 500, { error: "Unable to save password securely" });
      }
      passwordRecord = record;
      setupCode = "";
      await rm(setupCodeFile, { force: true }).catch(() => {});
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
      if (!(await passwordValid(body.password))) return reply(res, 401, { error: "Invalid password" });
      const remember = body.remember === true;
      const ttl = remember ? REMEMBER_TTL : SESSION_TTL;
      const now = Date.now();
      for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
      if (sessions.size >= MAX_SESSIONS) return reply(res, 503, { error: "Session capacity is full; try again later." });
      const id = randomBytes(32).toString("base64url");
      const key = sessionKey(id);
      const createdAt = Date.now();
      sessions.set(key, { createdAt, expiresAt: createdAt + ttl });
      try { await persistSessions(); }
      catch {
        sessions.delete(key);
        return reply(res, 500, { error: "Unable to persist session securely" });
      }
      authLimiter.reset(req.socket.remoteAddress || "unknown");
      return reply(res, 200, { authenticated: true, remembered: remember }, "application/json; charset=utf-8", {
        "set-cookie": `nas_agent_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttl / 1000)}${externalOrigin(req).secure ? "; Secure" : ""}`
      });
    }
    if (req.method === "POST" && url.pathname === "/api/logout") {
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      const active = sessionFor(req);
      if (active) { sessions.delete(active.key); await persistSessions(); }
      return reply(res, 200, { authenticated: false }, "application/json; charset=utf-8", {
        "set-cookie": `nas_agent_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${externalOrigin(req).secure ? "; Secure" : ""}`
      });
    }
    if (url.pathname === "/api/files") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      try {
        const rawLimit = Number(url.searchParams.get("limit") || 100);
        const rawOffset = Number(url.searchParams.get("offset") || 0);
        const sort = url.searchParams.get("sort") || "directories-first";
        const query = url.searchParams.get("q") || "";
        const type = url.searchParams.get("type") || "all";
        if (!Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset > 100_000)
          return reply(res, 400, { error: "Invalid directory pagination offset" });
        if (!["directories-first", "name-asc", "name-desc", "size-desc", "modified-desc"].includes(sort))
          return reply(res, 400, { error: "Invalid directory sort mode" });
        if (query.length > 160) return reply(res, 400, { error: "Directory search query is too long" });
        if (!["all", "directory", "file"].includes(type)) return reply(res, 400, { error: "Invalid directory type filter" });
        const result = await fileBrowser.list(url.searchParams.get("path") || "", rawLimit, rawOffset, sort, query, type);
        return reply(res, 200, result);
      } catch (error) {
        const status = [400, 403, 404, 409].includes(error?.statusCode) ? error.statusCode : 500;
        return reply(res, status, {
          error: status === 403 ? "Path is outside configured storage roots" :
            status === 404 ? "Directory not found" :
            status === 400 ? "Invalid directory path" :
            status === 409 ? "Directory changed while listing; retry the operation" :
            "Unable to list directory"
        });
      }
    }
    if (url.pathname === "/api/files/checksum") {
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      const activeSession = sessionFor(req);
      if (!activeSession) return reply(res, 401, { error: "Unauthorized" });
      if (!fileChecksumLimiter.allow(activeSession.key))
        return reply(res, 429, { error: "File checksum is limited to 5 requests per minute." }, "application/json; charset=utf-8", { "retry-after": "60" });
      try {
        return reply(res, 200, await fileManager.checksum(url.searchParams.get("path") || ""));
      } catch (error) {
        const status = [400, 403, 404, 409, 413].includes(error?.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: status === 500 ? "Unable to calculate file checksum" : error.message });
      }
    }
    if (url.pathname === "/api/files/duplicates") {
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      const activeSession = sessionFor(req);
      if (!activeSession) return reply(res, 401, { error: "Unauthorized" });
      if (!duplicateScanLimiter.allow(activeSession.key))
        return reply(res, 429, { error: "Duplicate scan is limited to 3 requests per minute." }, "application/json; charset=utf-8", { "retry-after": "60" });
      const rawLimit = Number(url.searchParams.get("limit") || 200);
      if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 500)
        return reply(res, 400, { error: "limit must be between 1 and 500" });
      const requestedPath = url.searchParams.get("path") || "";
      try {
        return reply(res, 200, await duplicateScanner.scan({ dir: requestedPath, limit: rawLimit }));
      } catch (error) {
        const status = [400, 403, 404, 409, 413].includes(error?.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: status === 500 ? "Unable to scan for duplicate files" : error.message });
      }
    }
    if (url.pathname === "/api/files/preview") {
      if (!sessionFor(req)) return reply(res,401,{error:"Unauthorized"});
      if(req.method!=="GET")return reply(res,405,{error:"Method not allowed"},"application/json; charset=utf-8",{allow:"GET"});
      try{return reply(res,200,await fileManager.preview(url.searchParams.get("path")||""));}
      catch(e){const s=[400,403,404,409,413,415].includes(e?.statusCode)?e.statusCode:500;return reply(res,s,{error:s===500?"Unable to preview file":e.message});}
    }
    if (url.pathname === "/api/files/download") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      let item = null;
      let streaming = false;
      try {
        item = await fileManager.download(url.searchParams.get("path") || "");
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": item.sizeBytes,
          "content-disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(item.name),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
          "referrer-policy": "no-referrer"
        });
        const stream = item.handle.createReadStream({ autoClose: true });
        streaming = true;
        res.once("close", () => { stream.destroy(); });
        stream.on("error", () => {
          if (!res.headersSent) reply(res, 500, { error: "Unable to download file" });
          else res.destroy();
        });
        stream.pipe(res);
        return;
      } catch (error) {
        if (item?.handle && !streaming) await item.handle.close().catch(() => {});
        const status = [400, 403, 404, 409].includes(error?.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: status === 500 ? "Unable to download file" : error.message });
      }
    }
    if (url.pathname === "/api/files/upload") {
      if(req.method!=="POST")return reply(res,405,{error:"Method not allowed"},"application/json; charset=utf-8",{allow:"POST"});
      if(!sessionFor(req))return reply(res,401,{error:"Unauthorized"});if(!sameOrigin(req))return reply(res,403,{error:"Forbidden origin"});
      // Uploads mutate the storage volume, so the global execution policy applies here too.
      const uploadDecision=executionPolicy.evaluate({risk:"write",approved:false});
      if(!uploadDecision.allowed)return reply(res,uploadDecision.statusCode||403,{error:policyMessage(uploadDecision)});
      if((req.headers["content-type"]||"").split(";")[0].trim().toLowerCase()!=="application/octet-stream")return reply(res,415,{error:"Upload requires application/octet-stream"});
      let name;try{name=decodeURIComponent(url.searchParams.get("name")||"");}catch{return reply(res,400,{error:"Invalid file name"});}
      try{const buffer=await rawBody(req,fileManager.limits.maxUploadBytes);return reply(res,201,await fileManager.upload(url.searchParams.get("path")||"",name,buffer));}
      catch(e){const s=[400,403,404,409,413].includes(e?.statusCode)?e.statusCode:500;return reply(res,s,{error:s===500?"Unable to upload file":e.message});}
    }
    if (url.pathname === "/api/files/operation") {
      if(req.method!=="POST")return reply(res,405,{error:"Method not allowed"},"application/json; charset=utf-8",{allow:"POST"});
      const active=sessionFor(req);if(!active)return reply(res,401,{error:"Unauthorized"});if(!sameOrigin(req))return reply(res,403,{error:"Forbidden origin"});
      if(!(req.headers["content-type"]||"").toLowerCase().startsWith("application/json"))return reply(res,415,{error:"Expected application/json"});
      const body=await jsonBody(req);
      const risk=fileActionRisk(body&&body.action);
      if(risk==="destructive"){
        // A client supplied boolean is not an authorization decision. Deletion always
        // becomes a pending approval that the server confirms with a one-time capability.
        const decision=executionPolicy.evaluate({risk,approved:false});
        if(!decision.allowed&&decision.requiresApproval===true){
          try{
            const approval=actionApprovals.request({toolId:"files.delete",args:{path:body.path},sessionId:active.key});
            return reply(res,202,{approvalRequired:true,approval,message:"Deletion requires an explicit confirmation."});
          }catch(error){const s=[400,409,429].includes(error?.statusCode)?error.statusCode:500;return reply(res,s,{error:s===500?"Unable to request approval":error.message});}
        }
        if(!decision.allowed)return reply(res,decision.statusCode||403,{error:policyMessage(decision)});
        return reply(res,403,{error:"Destructive file operations must be approved by the server."});
      }
      if(risk==="write"){
        const decision=executionPolicy.evaluate({risk,approved:false});
        if(!decision.allowed)return reply(res,decision.statusCode||403,{error:policyMessage(decision)});
      }
      try{return reply(res,200,await fileManager.operate(body));}
      catch(e){const s=[400,403,404,409,413,415,503,507].includes(e?.statusCode)?e.statusCode:500;return reply(res,s,{error:s===500?"File operation failed":e.message});}
    }
    if (url.pathname === "/api/files/rename-plan") {
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      // 只规划、不落盘：规划器是纯函数，所以这个接口可以放心地在预览阶段反复调用。
      const body = await jsonBody(req);
      const plan = planBatchRename(body?.entries, body?.rule, { maxEntries: MAX_BATCH_RENAME_APPLY });
      return reply(res, 200, plan);
    }
    if (url.pathname === "/api/files/rename-apply") {
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      const body = await jsonBody(req);
      // 批量改名会一次动很多文件，所以必须由前端显式带上 confirm；客户端的一个
      // 布尔值不是授权决定，这里只是防止误触，真正的闸门仍是执行策略与逐条校验。
      if (body?.confirm !== true) return reply(res, 400, { error: "Batch rename requires confirm: true" });
      const decision = executionPolicy.evaluate({ risk: "write", approved: false });
      if (!decision.allowed) return reply(res, decision.statusCode || 403, { error: policyMessage(decision) });
      const plan = planBatchRename(body?.entries, body?.rule, { maxEntries: MAX_BATCH_RENAME_APPLY });
      if (plan.ok !== true) return reply(res, 409, { error: "Plan has conflicts or errors; nothing was renamed", plan });
      try {
        const result = await applyBatchRenamePlan(plan, {
          rename: async (from, to) => {
            const target = to.split("/").pop() || "";
            await fileManager.operate({ action: "rename", path: from, name: target });
          }
        });
        return reply(res, result.failed ? 409 : 200, { ok: result.failed === null, plan: plan.summary, result });
      } catch (error) {
        const status = [400, 403, 404, 409, 413, 415, 503, 507].includes(error?.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: status === 500 ? "Batch rename failed" : error.message });
      }
    }
    if (url.pathname === "/api/files/operations/batch") {
      if (req.method !== "POST") return reply(res,405,{error:"Method not allowed"},"application/json; charset=utf-8",{allow:"POST"});
      if (!sessionFor(req)) return reply(res,401,{error:"Unauthorized"});
      if (!sameOrigin(req)) return reply(res,403,{error:"Forbidden origin"});
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return reply(res,415,{error:"Expected application/json"});
      const body = await jsonBody(req);
      const operations = Array.isArray(body?.operations) ? body.operations : [];
      if (operations.some(item => fileActionRisk(item?.action) === "destructive"))
        return reply(res,409,{error:"Destructive actions must be confirmed one at a time; request them through /api/files/operation."});
      if (operations.some(item => fileActionRisk(item?.action) === "write")) {
        const decision = executionPolicy.evaluate({ risk: "write", approved: false });
        if (!decision.allowed) return reply(res, decision.statusCode || 403, { error: policyMessage(decision) });
      }
      try { return reply(res,200,await fileManager.operateBatch(body)); }
      catch (e) { const s=[400,413].includes(e?.statusCode)?e.statusCode:500; return reply(res,s,{error:s===500?"Batch file operation request failed":e.message}); }
    }
    if (req.method === "GET" && url.pathname === "/api/diagnostics") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      return reply(res, 200, await readOnlyDiagnostics());
    }
    if (url.pathname === "/api/execution-mode") {
      // The kill switch must stay reachable even while it is engaged, otherwise an
      // operator could not lift it again from the console.
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method === "GET")
        return reply(res, 200, { mode: executionPolicy.mode(), source: executionPolicy.source(), modes: EXECUTION_MODES });
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET, POST" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      const body = await jsonBody(req);
      if (typeof body?.mode !== "string" || !EXECUTION_MODES.includes(body.mode.trim().toLowerCase()))
        return reply(res, 400, { error: `Unknown execution mode; expected one of ${EXECUTION_MODES.join(", ")}` });
      try {
        const result = await executionPolicy.setMode(body.mode.trim().toLowerCase());
        return reply(res, 200, { ...result, modes: EXECUTION_MODES });
      } catch (error) {
        const status = [500, 503].includes(error?.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: status === 500 ? "Unable to store the execution mode" : error.message });
      }
    }
    if (url.pathname === "/api/audit") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      if (!auditLogger) return reply(res, 503, { error: "Audit logging is not configured" });
      const requested = Number(url.searchParams.get("limit") || 20);
      const requestedOffset = Number(url.searchParams.get("offset") || 0);
      const outcome = url.searchParams.get("outcome") || undefined;
      const routeFilter = url.searchParams.get("route") || undefined;
      const limit = Number.isInteger(requested) ? Math.max(1, Math.min(50, requested)) : 20;
      if (!Number.isInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > 1000)
        return reply(res, 400, { error: "Invalid audit pagination" });
      if (outcome && !["success", "rejected", "error"].includes(outcome))
        return reply(res, 400, { error: "Invalid audit outcome filter" });
      if (routeFilter && (routeFilter.length > 80 || !/^[a-z][a-z0-9.-]*$/.test(routeFilter)))
        return reply(res, 400, { error: "Invalid audit route filter" });
      const readAudit = async path => { try { return await readFile(path, "utf8"); } catch (e) { if (e.code === "ENOENT") return ""; throw e; } };
      try {
        const currentPath = auditLogger.filePath();
        const [rotated, current] = await Promise.all([readAudit(currentPath + ".1"), readAudit(currentPath)]);
        const allEvents = (rotated + "\n" + current).split("\n").filter(Boolean).map(line => {
          try {
            const item = JSON.parse(line);
            const event = { at: item.at, method: item.method, route: item.route, statusCode: item.statusCode, outcome: item.outcome };
            // The session digest ties an action to the session that requested it. It is
            // a hash of the session id, never the session token itself.
            if (typeof item.sessionId === "string" && item.sessionId) event.sessionId = item.sessionId;
            return event;
          }
          catch { return null; }
        }).filter(Boolean).reverse().filter(item => (!outcome || item.outcome === outcome) && (!routeFilter || item.route === routeFilter));
        const events = allEvents.slice(requestedOffset, requestedOffset + limit);
        return reply(res, 200, { events, total: allEvents.length, limit, offset: requestedOffset, outcome: outcome || null, route: routeFilter || null });
      } catch { return reply(res, 500, { error: "Unable to read audit history" }); }
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
        const q = url.searchParams.get("q") || "";
        if (state && !skillStates.includes(state)) return reply(res, 400, { error: "Invalid Skill state" });
        if (q.length > 100) return reply(res, 400, { error: "Skill search query is too long" });
        return reply(res, 200, skillStore.list({ limit, offset, state, q }));
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
    if (url.pathname === "/api/skills/import-remote") {
      const activeSession = sessionFor(req);
      if (!activeSession) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!skillStore) return reply(res, 503, { error: "App data directory is not configured" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      if (!skillRemoteImportLimiter.allow(activeSession.key))
        return reply(res, 429, { error: "GitHub Skill imports are limited to 5 attempts per minute." }, "application/json; charset=utf-8", { "retry-after": "60" });
      let body;
      try { body = await jsonBody(req); }
      catch (error) { return reply(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, { error: "Invalid JSON body" }); }
      if (!body || typeof body !== "object" || Array.isArray(body))
        return reply(res, 400, { error: "Expected a JSON object." });
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const version = typeof body.version === "string" ? body.version.trim() : "";
      if (!name || name.length > 100 || version.length > 40)
        return reply(res, 400, { error: "Skill name is required; name or version exceeds its length limit." });
      try {
        const archive = await fetchGitHubSkillArchive(body.url, { maxBytes: MAX_ARCHIVE_BYTES });
        const sourcePrefix = "GitHub: " + archive.repository + (archive.refType && archive.branch ? "@" + archive.refType + "/" + archive.branch : "");
        const sourceLabel = (sourcePrefix.slice(0, Math.max(0, 100 - (archive.commitSha ? 41 : 0))) + (archive.commitSha ? "#" + archive.commitSha : "")).slice(0, 100);
        const skill = await skillStore.importArchive({ name, version, sourceLabel }, archive.buffer);
        return reply(res, 201, {
          skill, repository: archive.repository, branch: archive.branch, refType: archive.refType,
          commitSha: archive.commitSha, resolvedFromRepository: archive.resolvedFromRepository,
          archiveBytes: archive.bytes, redirects: archive.redirects,
          note: "GitHub archive stored in quarantine; no extraction or execution occurred."
        });
      } catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
        return reply(res, status, { error: status >= 500 ? (error?.code?.startsWith("SKILL_REMOTE_") ? error.message : "Unable to import GitHub Skill archive.") : error.message });
      }
    }
    if (url.pathname === "/api/skills/import-remote-batch") {
      const activeSession = sessionFor(req);
      if (!activeSession) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!skillStore) return reply(res, 503, { error: "App data directory is not configured" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      if (!skillRemoteImportLimiter.allow(activeSession.key))
        return reply(res, 429, { error: "GitHub Skill imports are limited to 5 requests per minute." }, "application/json; charset=utf-8", { "retry-after": "60" });
      let body;
      try { body = await jsonBody(req); }
      catch (error) { return reply(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, { error: "Invalid JSON body" }); }
      if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.items))
        return reply(res, 400, { error: "Expected a JSON object containing an items array." });
      try {
        const result = await importGitHubSkillBatch(body.items, {
          importArchive: (input, archiveBuffer) => skillStore.importArchive(input, archiveBuffer)
        });
        return reply(res, 200, {
          ...result,
          note: "Each successful ZIP is in quarantine and requires static review; downloaded code was not extracted or executed."
        });
      } catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: status >= 500 ? "Unable to process GitHub Skill batch." : error.message });
      }
    }

    const skillSourceFilesMatch = url.pathname.match(/^\/api\/skills\/([a-f0-9]{24})\/source-files$/);
    if (skillSourceFilesMatch) {
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (!skillStore) return reply(res, 503, { error: "App data directory is not configured" });
      const rawLimit = Number(url.searchParams.get("limit") || 100);
      const rawOffset = Number(url.searchParams.get("offset") || 0);
      if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100 ||
          !Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset > 10000)
        return reply(res, 400, { error: "Invalid source file pagination" });
      try {
        return reply(res, 200, await skillStore.listSourceFiles(skillSourceFilesMatch[1], {
          limit: rawLimit, offset: rawOffset
        }));
      } catch (error) {
        const status = [400, 404, 409, 413, 415].includes(error?.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: status === 500 ? "Unable to inspect quarantined Skill archive" : error.message });
      }
    }
    const skillSourcePreviewMatch = url.pathname.match(/^\/api\/skills\/([a-f0-9]{24})\/source-preview$/);
    if (skillSourcePreviewMatch) {
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (!skillStore) return reply(res, 503, { error: "App data directory is not configured" });
      try {
        return reply(res, 200, await skillStore.previewSourceFile(skillSourcePreviewMatch[1], url.searchParams.get("path") || ""));
      } catch (error) {
        const status = [400, 404, 409, 413, 415].includes(error?.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: status === 500 ? "Unable to preview quarantined Skill source" : error.message });
      }
    }

    if (url.pathname === "/api/skills/transitions/batch") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      if (!skillStore) return reply(res, 503, { error: "App data directory is not configured" });
      let body;
      try { body = await jsonBody(req); } catch (error) { return reply(res, 400, { error: "Invalid JSON body" }); }
      if (!body || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20)
        return reply(res, 400, { error: "items must contain 1 to 20 Skill transitions" });
      if (body.items.some(item => !item || typeof item !== "object" || Array.isArray(item) ||
          typeof item.id !== "string" || !/^[a-f0-9]{24}$/.test(item.id) ||
          typeof item.state !== "string" || (item.note !== undefined && typeof item.note !== "string")))
        return reply(res, 400, { error: "Each transition requires a valid Skill ID and target state" });
      if (new Set(body.items.map(item => item.id)).size !== body.items.length)
        return reply(res, 400, { error: "Duplicate Skill IDs are not allowed" });
      const results = [];
      for (const item of body.items) {
        try {
          const skill = await skillStore.transition(item.id, { state: item.state, note: item.note });
          results.push({ id: item.id, ok: true, state: skill.state });
        } catch (error) {
          const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
          results.push({ id: item.id, ok: false, statusCode: status, error: status === 500 ? "Unable to update Skill state" : error.message });
        }
      }
      return reply(res, 200, { total: results.length, succeeded: results.filter(item => item.ok).length,
        failed: results.filter(item => !item.ok).length, results });
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
    const installCliMatch = url.pathname.match(/^\/api\/skills\/([a-f0-9]{24})\/install-cli$/);
    if (installCliMatch) {
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!skillStore || !skillInstaller) return reply(res, 503, { error: "App data directory is not configured" });
      const record = skillStore.list({ limit: 500 }).skills.find(item => item.id === installCliMatch[1]);
      if (!record) return reply(res, 404, { error: "Skill not found" });
      try {
        const installation = await skillInstaller.installCli(record);
        return reply(res, 200, { installation, note: "仅提取了匹配当前 Linux 架构的 CLI 二进制；没有解压其他归档内容，也没有执行 Skill 指令。启用 Skill 后才会使用此 CLI。" });
      } catch (error) {
        const status = [400, 403, 404, 409, 413].includes(error?.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: status === 500 ? "Unable to install the official CLI binary safely" : error.message });
      }
    }
    const skillDeleteMatch = url.pathname.match(/^\/api\/skills\/([a-f0-9]{24})$/);
    if (skillDeleteMatch) {
      if (req.method !== "DELETE") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "DELETE" });
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!skillStore) return reply(res, 503, { error: "App data directory is not configured" });
      try { return reply(res, 200, await skillStore.remove(skillDeleteMatch[1])); }
      catch (error) { const status = [404, 409].includes(error?.statusCode) ? error.statusCode : 500; return reply(res, status, { error: status === 500 ? "Unable to remove Skill record" : error.message }); }
    }
    if (url.pathname === "/api/models/presets") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      return reply(res, 200, { presets: listModelProviderPresets() });
    }
    if (url.pathname === "/api/models") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (!modelProviderStore) return reply(res, 503, { error: "模型管理需要配置 Agent 私有数据目录。" });
      if (req.method === "GET") {
        try {
          return reply(res, 200, { ...modelProviderStore.list(), modelStatus: modelAdapter.status(), storage: modelProviderStore.status(), metrics: modelAdapter.metrics() });
        } catch (error) {
          return reply(res, error.statusCode || 503, { error: error.statusCode ? error.message : "模型配置暂不可用。" });
        }
      }
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET, POST" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return reply(res, 415, { error: "Expected application/json" });
      try { return reply(res, 201, { provider: await modelProviderStore.add(await jsonBody(req)) }); }
      catch (error) { const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500; return reply(res, status, { error: error.statusCode ? error.message : "Unable to save model provider securely." }); }
    }
    const modelCatalogMatch = url.pathname.match(/^\/api\/models\/([a-f0-9]{24})\/catalog$/);
    if (modelCatalogMatch) {
      const activeSession = sessionFor(req);
      if (!activeSession) return reply(res, 401, { error: "Unauthorized" });
      if (!modelProviderStore) return reply(res, 503, { error: "模型管理需要配置 Agent 私有数据目录。" });
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!modelActionLimiter.allow(activeSession.key)) return reply(res, 429, { error: "模型操作过于频繁，请稍后再试。" }, "application/json; charset=utf-8", { "retry-after": "60" });
      try {
        const result = await modelProviderStore.discoverModels(modelCatalogMatch[1]);
        return reply(res, result.ok ? 200 : (result.statusCode === 401 || result.statusCode === 403 ? 502 : 200), result);
      } catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: error.statusCode ? error.message : "Unable to discover provider models." });
      }
    }
    const modelItemMatch = url.pathname.match(/^\/api\/models\/([a-f0-9]{24})$/);
    if (modelItemMatch) {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (!modelProviderStore) return reply(res, 503, { error: "模型管理需要配置 Agent 私有数据目录。" });
      if (!["PUT", "DELETE"].includes(req.method)) return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "PUT, DELETE" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      try {
        if (req.method === "DELETE") return reply(res, 200, await modelProviderStore.remove(modelItemMatch[1]));
        if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return reply(res, 415, { error: "Expected application/json" });
        return reply(res, 200, { provider: await modelProviderStore.update(modelItemMatch[1], await jsonBody(req)) });
      } catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: error.statusCode ? error.message : "Unable to update model provider securely." });
      }
    }
    const modelActionMatch = url.pathname.match(/^\/api\/models\/([a-f0-9]{24})\/(default|test)$/);
    if (modelActionMatch) {
      const activeSession = sessionFor(req);
      if (!activeSession) return reply(res, 401, { error: "Unauthorized" });
      if (!modelProviderStore) return reply(res, 503, { error: "模型管理需要配置 Agent 私有数据目录。" });
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (modelActionMatch[2] === "test" && !modelActionLimiter.allow(activeSession.key))
        return reply(res, 429, { error: "模型操作过于频繁，请稍后再试。" }, "application/json; charset=utf-8", { "retry-after": "60" });
      try {
        if (modelActionMatch[2] === "default") return reply(res, 200, { provider: await modelProviderStore.setDefault(modelActionMatch[1]) });
        return reply(res, 200, await modelProviderStore.test(modelActionMatch[1]));
      } catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: error.statusCode ? error.message : "模型操作失败。" });
      }
    }
    if (url.pathname === "/api/agent/status") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      let trimCliStatus;
      try {
        const raw = await trimCli.status();
        trimCliStatus = {
          ...raw,
          installationStatus: raw.available ? "installed" : raw.configured ? "unavailable" : "not_installed",
          connectionStatus: raw.connectionStatus || (raw.available ? "not_tested" : "not_ready"),
          authenticated: raw.authenticated ?? null,
          note: raw.message || (raw.available
            ? "CLI 可执行，但尚未验证 OAuth 授权和 NAS API 连通性。"
            : raw.configured ? "已配置 CLI 路径，但当前无法执行。" : "尚未找到已安装的官方 CLI。")
        };
      } catch {
        trimCliStatus = { configured: false, available: false, installationStatus: "unknown", connectionStatus: "unknown", authenticated: null, errorCategory: "status_unavailable", reason: "Status unavailable", nextAction: "检查 Agent 日志与私有数据目录配置。" };
      }
      return reply(res, 200, { ...agentCore.status(), trimCli: trimCliStatus });
    }
    if (url.pathname === "/api/agent/trim-cli/test") {
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      let before;
      try { before = await trimCli.status(); }
      catch { return reply(res, 503, { ok: false, connectionStatus: "not_ready", authenticated: null, errorCategory: "status_unavailable", error: "无法读取官方 CLI 状态。", nextAction: "检查 Agent 日志、Skill 启用状态和私有数据目录。" }); }
      if (!before.available) return reply(res, 503, {
        ok: false,
        connectionStatus: before.connectionStatus || "not_ready",
        authenticated: null,
        errorCategory: "not_ready",
        error: before.reason || before.message || "官方 CLI 未安装或不可执行。",
        nextAction: before.nextAction || "先安装官方 CLI，并启用官方 fnOS Skill。"
      });
      try {
        const result = await trimCli.runReadOnly("system.info");
        const connection = trimCli.connectionHealth();
        return reply(res, 200, {
          ok: true,
          connectionStatus: connection.connectionStatus,
          authenticated: connection.authenticated,
          checkedAt: connection.checkedAt,
          command: result.command,
          data: result.data,
          note: connection.message,
          nextAction: connection.nextAction
        });
      } catch (error) {
        const status = [400, 401, 403, 404, 408, 429, 502, 503, 504].includes(error?.statusCode) ? error.statusCode : 502;
        return reply(res, status, {
          ok: false,
          connectionStatus: error?.connectionStatus || trimCli.connectionHealth().connectionStatus || "failed",
          authenticated: error?.authenticated ?? null,
          errorCategory: error?.errorCategory || "unexpected",
          error: error?.message || "连接探测失败；敏感 CLI 输出已隐藏。",
          nextAction: error?.nextAction || "检查 profile、授权和 NAS 网络后重试。",
          code: error?.code || "TRIM_CLI_PROBE_FAILED"
        });
      }
    }
    if (url.pathname === "/api/agent/trim-cli/login-command") {
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      let input;
      try { input = validateTrimCliLoginInput(await jsonBody(req)); }
      catch (error) { return reply(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, { error: error.message || "Invalid login command options" }); }
      let setup;
      try { setup = await trimCli.setupInfo(); }
      catch { return reply(res, 503, { error: "无法读取官方 CLI 配置状态，请检查 Agent 配置。" }); }
      if (!setup.available || !setup.binaryPath)
        return reply(res, 503, { error: "官方 CLI 尚未安装或不可执行。请先导入并审核官方 fnOS Skill、安装对应平台 CLI，并启用 Skill。" });
      if (!setup.dataDirConfigured || !setup.dataDir || !setup.configDir)
        return reply(res, 503, { error: "Agent 私有数据目录未配置，无法安全设置 OAuth profile。" });
      let serviceUser;
      try { serviceUser = os.userInfo().username; }
      catch { return reply(res, 503, { error: "无法识别 Agent 运行账户；请检查系统账户配置。" }); }
      if (typeof process.getuid === "function" && process.getuid() !== os.userInfo().uid)
        return reply(res, 503, { error: "Agent 运行账户信息不一致，拒绝生成登录命令。" });
      try {
        const command = createTrimCliLoginCommand({
          ...input,
          binaryPath: setup.binaryPath,
          dataDir: setup.dataDir,
          profile: setup.profile,
          serviceUser
        });
        return reply(res, 200, {
          command,
          profile: setup.profile,
          flow: input.flow,
          note: "命令只会在 NAS 终端启动官方 CLI 的交互式授权；Agent 不会执行该命令、接收验证码或记录令牌。"
        });
      } catch (error) {
        return reply(res, Number.isInteger(error?.statusCode) ? error.statusCode : 503, {
          error: error?.statusCode === 400 ? error.message : "无法生成安全的 CLI 登录命令；请检查 Agent 数据目录和运行账户。"
        });
      }
    }
    if (url.pathname === "/api/agent/message") {
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!agentMessageLimiter.allow(active.key))
        return reply(res, 429, { error: "消息过于频繁，请稍后再试。" }, "application/json; charset=utf-8", { "retry-after": "60" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      const input = await jsonBody(req);
      if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.text !== "string" || !input.text.trim() || input.text.trim().length > 2000)
        return reply(res, 400, { error: "Message must contain 1 to 2000 characters" });
      let history;
      try { history = normalizeConversationHistory(input.history); }
      catch { return reply(res, 400, { error: "Conversation history is invalid or too large" }); }
      let task;
      try { task = taskManager.submit({ text: input.text.trim(), history }, { sessionId: active.key }); }
      catch (error) {
        const status = Number.isInteger(error?.statusCode) && [429, 503].includes(error.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: status === 429 ? "Task queue is full; try again shortly." : status === 503 ? "Task capacity is temporarily full; try again shortly." : "Unable to accept task." }, "application/json; charset=utf-8", status === 429 ? { "retry-after": "2" } : {});
      }
      return reply(res, 202, { task });
    }
    if (url.pathname === "/api/chat/message") {
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!modelChatAdapter) return reply(res, 503, { error: "模型直聊通道不可用：未配置应用数据目录。" });
      if (!chatMessageLimiter.allow(active.key))
        return reply(res, 429, { error: "消息过于频繁，请稍后再试。" }, "application/json; charset=utf-8", { "retry-after": "60" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      const input = await jsonBody(req);
      if (!input || typeof input !== "object" || Array.isArray(input) || !Array.isArray(input.messages))
        return reply(res, 400, { error: "Chat message must contain a messages array" });
      // The stream is the answer of this route, so the headers are written
      // before the provider is called. The upstream error is reported inside
      // the stream, the HTTP status stays 200 for a started stream.
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.write("retry: 2000\n\n");
      const controller = new AbortController();
      req.on("close", () => { if (!controller.signal.aborted) controller.abort(); });
      const write = (type, payload) => {
        try { res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* the client is gone */ }
      };
      const startedAt = Date.now();
      try {
        const text = await modelChatAdapter.chat({
          messages: input.messages,
          signal: controller.signal,
          onDelta: chunk => { write("delta", { text: chunk }); }
        });
        recordChatUsage({ messages: input.messages, completionText: typeof text === "string" ? text : "", outcome: "ok", latencyMs: Date.now() - startedAt });
        write("done", { text: typeof text === "string" ? text : "" });
      } catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
        recordChatUsage({ messages: input.messages, completionText: "", outcome: "error", latencyMs: Date.now() - startedAt });
        write("error", {
          code: typeof error?.code === "string" ? error.code : "MODEL_CHAT_UPSTREAM_ERROR",
          message: typeof error?.message === "string" ? error.message : "模型直聊失败。",
          statusCode: status
        });
      }
      try { res.end(); } catch { /* already closed */ }
      return undefined;
    }
    if (url.pathname === "/api/chat/status") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      if (!modelChatAdapter) return reply(res, 503, { error: "模型直聊通道不可用：未配置应用数据目录。" });
      return reply(res, 200, modelChatAdapter.status());
    }
    if (url.pathname === "/api/system/snapshot") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      // The snapshot is a read-only measurement. A section that could not be
      // measured is reported as "unknown", it is never presented as healthy.
      const snapshot = await buildSystemSnapshot({ collect: (sectionId) => systemCollector.collect(sectionId) });
      return reply(res, 200, snapshot);
    }
    if (url.pathname === "/api/system/capabilities") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      const profile = url.searchParams.get("profile") || "agent-host";
      if (!Object.prototype.hasOwnProperty.call(DEVICE_PROFILES, profile))
        return reply(res, 400, { error: `Unknown profile: ${profile}` });
      const report = evaluateDeviceCapabilities(
        deviceEnvironment({
          platform: process.platform,
          arch: process.arch,
          cpuCores: os.cpus().length,
          totalMemoryBytes: os.totalmem(),
          storageType: process.env.AGENT_STORAGE_TYPE || ""
        }),
        { profile }
      );
      return reply(res, 200, {
        ...report,
        note: report.dimensions.some((item) => item.id === "storage_type" && item.passed === null)
          ? "系统盘类型无法从进程侧读取；可用 AGENT_STORAGE_TYPE=ssd|hdd 显式声明后再看结论。"
          : ""
      });
    }
    if (url.pathname === "/api/system/services") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      // 只读：固定 argv 的 `systemctl show`，unit 名单在服务端常量里，请求方
      // 不能指定要查哪个 unit，否则这里就变成读任意系统对象的口子。
      // 采集器起不来（无 systemctl / 无权限）时每条都是 unknown，不会被当成健康。
      const report = await collectServiceStatus({ units: FNOS_SERVICE_UNITS, run: serviceStatusCollector });
      return reply(res, 200, report);
    }
    if (url.pathname === "/api/system/capacity-forecast") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      // 每次读取都顺带采样一次：采样是去重的（同小时只留一条），所以刷新页
      // 不会把序列刷乱；没有磁盘数据可采时照样返回趋势，只是不新增采样点。
      const parsedHorizon = Number.parseInt(url.searchParams.get("horizonDays") || "", 10);
      const horizonDays = Number.isSafeInteger(parsedHorizon) ? Math.min(Math.max(parsedHorizon, 1), 365) : 30;
      const snapshot = await buildSystemSnapshot({ collect: (sectionId) => systemCollector.collect(sectionId) });
      const storage = snapshot.sections.find((section) => section.id === "storage");
      const disks = [];
      for (const disk of Array.isArray(storage?.values?.disks) ? storage.values.disks : []) {
        const name = typeof disk?.name === "string" ? disk.name : "";
        if (!name) continue;
        const usedBytes = typeof disk.usedBytes === "number" ? disk.usedBytes : null;
        const totalBytes = typeof disk.totalBytes === "number" ? disk.totalBytes : null;
        if (usedBytes === null && totalBytes === null) continue;
        disks.push({ name, usedBytes, totalBytes });
      }
      const at = new Date().toISOString();
      const sampling = disks.length
        ? capacityHistory.append({ at, disks: disks.map((disk) => ({ name: disk.name, totalBytes: disk.totalBytes, usedBytes: disk.usedBytes })) })
        : { appended: false, reason: "no-disk-data", records: capacityHistory.read().records };
      const records = Array.isArray(sampling.records) ? sampling.records : [];
      const trends = disks.slice(0, MAX_TREND_DISKS).map((disk) => {
        const series = [];
        for (const record of records) {
          const hit = record.disks.find((item) => item.name === disk.name);
          if (!hit || hit.usedBytes === null) continue;
          series.push({ at: record.at, diskUsedBytes: hit.usedBytes, diskTotalBytes: hit.totalBytes });
        }
        return { disk: disk.name, sampleCount: series.length, ...buildTrendVerdict(series, { horizonDays }) };
      });
      return reply(res, 200, {
        generatedAt: at,
        horizonDays,
        storageStatus: typeof storage?.status === "string" ? storage.status : "unknown",
        sampling: {
          appended: sampling.appended === true,
          reason: sampling.reason ?? null,
          storedRecords: records.length
        },
        disks: trends,
        note: trends.length
          ? "趋势只来自本机历次采样的磁盘用量；样本不足时只报当前用量，不给预测。"
          : "这次没有读到磁盘用量，趋势无法计算；系统快照的存储段可能是 unknown。"
      });
    }
    if (url.pathname === "/api/diagnostics/report") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      const input = await jsonBody(req);
      const symptom = typeof input?.symptom === "string" ? input.symptom.slice(0, 2000) : "";
      // The operator may bring evidence of their own. The evidence the server
      // collects is added to it: the audit log, the tool trace, the health
      // checks. The collector only reads whitelisted fields, so no prompt, no
      // credential and no stack trace reaches the report.
      const supplied = Array.isArray(input?.evidence) ? input.evidence.slice(0, 50) : [];
      const bundle = buildEvidenceBundle({
        auditEntries: auditLogger ? await auditLogger.read({ limit: 500 }) : [],
        traceEntries: toolTracer.list(),
        healthChecks: scheduledHealthChecks ? scheduledHealthChecks.list() : [],
        snapshots: [],
        symptom
      });
      const evidence = [
        ...supplied.map(item => ({ source: "operator", detail: typeof item?.detail === "string" ? item.detail : "" })).filter(item => item.detail),
        ...bundle.evidence
      ].slice(0, 200);
      // The report is a read-only diagnosis: it names the most likely causes
      // and the checks that would confirm them. It never performs a change.
      const report = buildDiagnosticReport({ symptom, evidence, causes: [], now: new Date().toISOString() });
      // The conclusion is written into the history: a diagnosis that is never
      // remembered cannot be corrected later. Only the symptom, the causes and
      // the evidence references are kept, the evidence text is not copied.
      let historyId = "";
      try {
        const record = diagnosisHistory.record({
          symptom: symptom || "未描述症状",
          causes: Array.isArray(report.causes) ? report.causes.slice(0, 10).map(cause => String(cause?.title || cause?.cause || cause || "")) : [],
          evidenceRefs: evidence.slice(0, 20).map(item => String(item?.source || "") + ":" + String(item?.detail || "").slice(0, 120))
        });
        historyId = record?.entry?.id || "";
      } catch (error) {
        console.error(`[history] Could not record the diagnosis: ${error?.message || "unknown error"}`);
      }
      return reply(res, 200, {
        ...report,
        evidenceSummary: bundle.stats,
        evidenceTruncated: bundle.truncated,
        historyId
      });
    }
    if (url.pathname === "/api/diagnostics/evidence") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      const symptom = url.searchParams.get("symptom") || "";
      // The snapshot is measured only when it is asked for: the collection
      // costs commands on the machine.
      const snapshots = url.searchParams.get("snapshot") === "1"
        ? await buildSystemSnapshot({ collect: (sectionId) => systemCollector.collect(sectionId) })
        : [];
      const evidence = collectDiagnosticEvidence({
        auditEntries: auditLogger ? await auditLogger.read({ limit: 500 }) : [],
        traceEntries: toolTracer.list(),
        healthChecks: scheduledHealthChecks ? scheduledHealthChecks.list() : [],
        snapshots,
        now: new Date().toISOString()
      });
      return reply(res, 200, { evidence, count: evidence.length });
    }
    if (url.pathname === "/api/diagnoses" || url.pathname === "/api/diagnoses/stats") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      if (url.pathname === "/api/diagnoses/stats") return reply(res, 200, diagnosisHistory.stats());
      const symptom = url.searchParams.get("symptom") || "";
      return reply(res, 200, diagnosisHistory.list({
        symptom,
        limit: numberParam(url.searchParams.get("limit"), 50, 200),
        offset: numberParam(url.searchParams.get("offset"), 0, 100000)
      }));
    }
    if (url.pathname.startsWith("/api/diagnoses/")) {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      const rest = url.pathname.slice("/api/diagnoses/".length);
      const diagnosisId = decodeURIComponent(rest.endsWith("/corrections") ? rest.slice(0, -"/corrections".length) : rest);
      if (!diagnosisHistory.get(diagnosisId)) return reply(res, 404, { error: "Not found" });
      if (rest.endsWith("/corrections")) {
        // A correction is a write: it needs a session, the same origin and a
        // JSON body. The original conclusion is kept, the correction is
        // appended as a traceable event.
        if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
        if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
        if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
          return reply(res, 415, { error: "Expected application/json" });
        const input = await jsonBody(req);
        const outcome = typeof input?.outcome === "string" ? input.outcome : "";
        if (!outcome) return reply(res, 400, { error: "An outcome is required" });
        const result = diagnosisHistory.applyCorrection(diagnosisId, {
          outcome,
          note: typeof input?.note === "string" ? input.note : "",
          correctedBy: typeof input?.correctedBy === "string" ? input.correctedBy : ""
        });
        if (!result?.corrected) return reply(res, result?.code === "not-found" ? 404 : 400, { error: result?.reason || "Rejected", code: result?.code || "rejected" });
        return reply(res, 200, { entry: result.entry });
      }
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      return reply(res, 200, diagnosisHistory.get(diagnosisId));
    }
    if (url.pathname === "/api/write-actions") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      // The list is empty on purpose: the server offers no write path it
      // cannot preview, approve and verify.
      const actions = verifiedWritePipeline.listActions();
      return reply(res, 200, { actions, registered: actions.length });
    }
    if (url.pathname === "/api/network/policy") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      // The settings are readable so the operator can see that the egress is
      // closed. The check itself never opens a connection.
      const settings = networkPolicy.settings();
      return reply(res, 200, {
        settings,
        open: Array.isArray(settings.allowList) && settings.allowList.length > 0
      });
    }
    if (url.pathname === "/api/network/diagnostics") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      // The server performs no network I/O itself. A GET returns a patrol in
      // which every check is unknown, a POST analyses the probes that were
      // measured elsewhere (by a read-only command the operator ran). Neither
      // form turns a missing measurement into a healthy one.
      if (req.method === "GET") return reply(res, 200, runConnectivityPatrol({}));
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET, POST" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      const input = await jsonBody(req);
      if (!input || typeof input !== "object" || Array.isArray(input)) return reply(res, 400, { error: "An object of probe data is required" });
      return reply(res, 200, runConnectivityPatrol(input));
    }
    if (url.pathname === "/api/network/check") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      const input = await jsonBody(req);
      const url = typeof input?.url === "string" ? input.url : "";
      if (!url) return reply(res, 400, { error: "A url is required" });
      // A check never opens a connection: it only asks the policy.
      const decision = await networkPolicy.isUrlAllowed(url);
      return reply(res, 200, { decision });
    }
    if (url.pathname === "/api/web/fetch") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      const input = await jsonBody(req);
      const url = typeof input?.url === "string" ? input.url : "";
      if (!url) return reply(res, 400, { error: "A url is required" });
      // The policy is closed by default, so this route normally refuses. It
      // never falls back to a direct request.
      const result = await webFetcher.fetchEvidence(url, { fetchedAt: new Date().toISOString() });
      if (!result.ok) {
        const status = result.error?.code === "invalid-url" ? 400 : result.error?.code === "network-url-not-allowed" ? 403 : 502;
        return reply(res, status, { error: result.error?.message || "Fetch failed", code: result.error?.code || "fetch-failed", reason: result.error?.reason || "" });
      }
      return reply(res, 200, { evidence: result.evidence, truncated: result.truncated === true });
    }
    if (url.pathname === "/api/security/inspection") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      const auditEntries = auditLogger ? await auditLogger.read({ limit: 500 }) : [];
      const toolCatalog = toolRegistry.list();
      const storageRoots = fileManager ? await fileManager.getRoots() : [];
      const inspection = runSecurityInspection({
        toolCatalog,
        auditEntries,
        config: { listenAddress: String(process.env.AGENT_HOST || "127.0.0.1") },
        scheduledChecks: scheduledHealthChecks ? scheduledHealthChecks.list() : [],
        storageRoots
      });
      return reply(res, 200, {
        ...inspection,
        toolPermissions: buildToolPermissionTable(toolCatalog),
        auditSummary: summarizeAuditEntries(auditEntries)
      });
    }
    if (url.pathname === "/api/models/usage") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      const summary = applyPrivacyMode(usageMeter.summary(), { privacyMode: privacyModeEnabled });
      return reply(res, 200, {
        summary,
        byModel: usageMeter.byModel(),
        privacy: {
          enabled: privacyModeEnabled,
          // The flag is a report flag. It does not block a cloud request, the
          // gate would have to live in the adapter of the provider.
          enforced: false,
          note: "隐私模式当前只统计云端调用，不拦截已发出的请求。"
        },
        capabilities: modelProviderStore ? describeModelCapabilities(modelProviderStore.runtimeConfig?.() || {}) : null
      });
    }
    if (url.pathname === "/api/workflows") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method === "GET") return reply(res, 200, { workflows: workflowEngine.listWorkflows() });
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET, POST" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      const input = await jsonBody(req);
      const workflowId = typeof input?.workflowId === "string" ? input.workflowId : "";
      if (!workflowId) return reply(res, 400, { error: "A workflow id is required" });
      // The engine asks for a tool: the server owns the catalogue and the
      // policy. The engine itself cannot execute anything.
      const result = await workflowEngine.runWorkflow(workflowId, {
        sessionId: active.key,
        invokeTool: async ({ tool, args }) => { await toolRegistry.invoke(tool, args || {}); },
        requestApproval: async () => ({ approved: false, reason: "工作流不自行批准任何步骤" }),
        notify: () => {}
      });
      if (!result.started) return reply(res, result.reason === "locked" ? 409 : 404, { error: result.reason === "locked" ? "The workflow is already running" : "Unknown workflow", reason: result.reason });
      return reply(res, 200, result);
    }
    if (url.pathname.startsWith("/api/workflows/") && url.pathname.endsWith("/events")) {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      const workflowId = decodeURIComponent(url.pathname.slice("/api/workflows/".length, -"/events".length));
      if (!workflowEngine.getWorkflow(workflowId)) return reply(res, 404, { error: "Unknown workflow" });
      return reply(res, 200, { workflowId, events: workflowEngine.workflowEvents(workflowId) });
    }
    if (url.pathname === "/api/runbooks/stats") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      return reply(res, 200, runbookStore.stats());
    }
    if (url.pathname === "/api/runbooks") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method === "GET") {
        const query = url.searchParams.get("q") || "";
        if (query) return reply(res, 200, runbookStore.search(query, { limit: numberParam(url.searchParams.get("limit"), 20, 100) }));
        return reply(res, 200, runbookStore.list({
          tag: url.searchParams.get("tag") || "",
          limit: numberParam(url.searchParams.get("limit"), 50, 200),
          offset: numberParam(url.searchParams.get("offset"), 0, 100000)
        }));
      }
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET, POST" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      const input = await jsonBody(req);
      // The store redacts the entry before it is written: a credential that
      // slipped into the text is replaced, the original text is never stored.
      const result = await runbookStore.put(input || {});
      if (!result.written) {
        const conflict = result.code === "duplicate-entry";
        return reply(res, conflict ? 409 : 400, { error: result.reason || "Rejected", code: result.code || "rejected" });
      }
      return reply(res, 201, { entry: result.entry, redactedFields: result.redactedFields || [] });
    }
    if (url.pathname.startsWith("/api/runbooks/")) {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      const runbookId = decodeURIComponent(url.pathname.slice("/api/runbooks/".length));
      if (req.method === "GET") {
        const entry = runbookStore.get(runbookId);
        if (!entry) return reply(res, 404, { error: "Not found" });
        return reply(res, 200, entry);
      }
      if (req.method !== "DELETE") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET, DELETE" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      const result = await runbookStore.remove(runbookId);
      if (!result.removed) {
        const missing = result.code === "not-found";
        return reply(res, missing ? 404 : 400, { error: result.reason || "Rejected", code: result.code || "rejected" });
      }
      return reply(res, 200, { removed: true, id: result.id });
    }
    if (url.pathname === "/api/knowledge/stats") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      return reply(res, 200, knowledgeBase.stats());
    }
    if (url.pathname === "/api/knowledge/conflicts") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      return reply(res, 200, knowledgeBase.conflicts());
    }
    // A write is always two steps: the preview shows what would be stored and
    // which fields were redacted, the commit stores exactly that preview. A
    // single call can never write.
    if (url.pathname === "/api/knowledge/preview") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      const input = await jsonBody(req);
      const operation = typeof input?.operation === "string" ? input.operation : "write";
      const result = knowledgeBase.preview(operation, input?.input ?? input ?? {});
      if (!result.ok) return reply(res, 400, { error: result.message || "Rejected", code: result.code || "rejected", reasons: result.reasons || [] });
      return reply(res, 200, result);
    }
    if (url.pathname === "/api/knowledge/commit") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      const input = await jsonBody(req);
      const previewId = typeof input?.previewId === "string" ? input.previewId : "";
      if (!previewId) return reply(res, 400, { error: "A previewId is required" });
      const result = knowledgeBase.commit(previewId);
      if (result.ok === false) return reply(res, 400, { error: result.message || "Rejected", code: result.code || "rejected" });
      return reply(res, 201, result);
    }
    if (url.pathname === "/api/knowledge") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      const query = {
        keyword: url.searchParams.get("q") || "",
        tag: url.searchParams.get("tag") || "",
        category: url.searchParams.get("category") || "",
        source: url.searchParams.get("source") || ""
      };
      const anyQuery = Object.values(query).some(Boolean);
      if (anyQuery) {
        return reply(res, 200, knowledgeBase.search(query, { limit: numberParam(url.searchParams.get("limit"), 20, 50) }));
      }
      return reply(res, 200, knowledgeBase.list({
        limit: numberParam(url.searchParams.get("limit"), 20, 50),
        offset: numberParam(url.searchParams.get("offset"), 0, 100000),
        includeArchived: url.searchParams.get("archived") === "1"
      }));
    }
    if (url.pathname.startsWith("/api/knowledge/")) {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      const rest = decodeURIComponent(url.pathname.slice("/api/knowledge/".length));
      if (rest.endsWith("/reference")) {
        const entryId = rest.slice(0, -"/reference".length);
        // A reference never reports a stored value as the current state: it
        // carries the collection time next to every fact.
        const result = knowledgeBase.reference(entryId);
        if (result.ok === false) return reply(res, 404, { error: result.message || "Not found", code: result.code || "not-found" });
        return reply(res, 200, result);
      }
      const entry = knowledgeBase.get(rest);
      if (!entry) return reply(res, 404, { error: "Not found" });
      return reply(res, 200, entry);
    }
    if (url.pathname === "/api/docker/advice") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      // Every section is read-only and every unmeasured section stays unknown.
      const inventory = await readDockerInventory();
      return reply(res, 200, buildDockerReport(inventory));
    }
    if (url.pathname === "/api/health-checks") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (!scheduledHealthChecks) return reply(res, 503, { error: "App data directory is not configured" });
      if (req.method === "GET") return reply(res, 200, scheduledHealthChecks.list());
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET, POST" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      const decision = executionPolicy.evaluate({ risk: "write", approved: false });
      if (!decision.allowed) return reply(res, decision.statusCode || 403, { error: policyMessage(decision) });
      try { return reply(res, 201, { check: await scheduledHealthChecks.create(await jsonBody(req)) }); }
      catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: status >= 500 ? "Unable to create scheduled health check" : error.message });
      }
    }
    const healthCheckRunMatch = url.pathname.match(/^\/api\/health-checks\/([a-f0-9-]{36})\/run$/i);
    if (healthCheckRunMatch) {
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!scheduledHealthChecks) return reply(res, 503, { error: "App data directory is not configured" });
      const decision = executionPolicy.evaluate({ risk: "write", approved: false });
      if (!decision.allowed) return reply(res, decision.statusCode || 403, { error: policyMessage(decision) });
      try { return reply(res, 200, await scheduledHealthChecks.runNow(healthCheckRunMatch[1])); }
      catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: status >= 500 ? "Unable to run scheduled health check" : error.message });
      }
    }
    const healthCheckMatch = url.pathname.match(/^\/api\/health-checks\/([a-f0-9-]{36})$/i);
    if (healthCheckMatch) {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (!scheduledHealthChecks) return reply(res, 503, { error: "App data directory is not configured" });
      if (req.method !== "PATCH" && req.method !== "PUT" && req.method !== "DELETE")
        return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "PATCH, PUT, DELETE" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      const decision = executionPolicy.evaluate({ risk: "write", approved: false });
      if (!decision.allowed) return reply(res, decision.statusCode || 403, { error: policyMessage(decision) });
      try {
        const id = healthCheckMatch[1];
        if (req.method === "DELETE") return reply(res, 200, await scheduledHealthChecks.remove(id));
        if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
          return reply(res, 415, { error: "Expected application/json" });
        return reply(res, 200, { check: await scheduledHealthChecks.update(id, await jsonBody(req)) });
      } catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: status >= 500 ? "Unable to update scheduled health check" : error.message });
      }
    }
    if (url.pathname === "/api/tasks/clear-history") {
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      try { return reply(res, 200, await taskManager.clearTerminal(active.key)); }
      catch { return reply(res, 500, { error: "Unable to clear task history" }); }
    }
    if (url.pathname === "/api/tasks/status") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      return reply(res, 200, taskManager.stats());
    }
    if (url.pathname === "/api/tasks") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      const requested = Number(url.searchParams.get("limit") || 20);
      const requestedOffset = Number(url.searchParams.get("offset") || 0);
      const status = url.searchParams.get("status") || undefined;
      const search = url.searchParams.get("q") || undefined;
      const allowedStatuses = new Set(["queued", "running", "awaiting-approval", "completed", "failed", "cancelled"]);
      if (status && !allowedStatuses.has(status)) return reply(res, 400, { error: "Invalid task status filter" });
      if (search && (search.length > 100 || /[\x00-\x1f\x7f]/.test(search)))
        return reply(res, 400, { error: "Invalid task search query" });
      if (!Number.isFinite(requested) || !Number.isFinite(requestedOffset) || requestedOffset < 0 || requestedOffset > 10000)
        return reply(res, 400, { error: "Invalid task pagination" });
      return reply(res, 200, taskManager.query({
        limit: Math.min(50, Math.max(1, Math.trunc(requested))),
        offset: Math.trunc(requestedOffset), status, search, sessionId: active.key
      }));
    }
    const cancelMatch = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]{8,64})\/cancel$/i);
    if (cancelMatch) {
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      const cancelSession = sessionFor(req);
      if (!cancelSession) return reply(res, 401, { error: "Unauthorized" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      const result = taskManager.cancel(cancelMatch[1], cancelSession.key);
      if (!result) return reply(res, 404, { error: "Task not found" });
      // A cancelled task must not leave a confirmed destructive action behind.
      if (result.cancelled) actionApprovals.revokeTask(cancelMatch[1]);
      if (result.cancelRequested) return reply(res, 202, {
        ...result,
        note: "Cancellation requested. The current tool will finish; no follow-up tool steps will be started."
      });
      if (!result.cancelled) return reply(res, 409, { error: "Task is already terminal or cannot be cancelled.", task: result.task });
      return reply(res, 200, result);
    }
    const taskEventsMatch = url.pathname.match(new RegExp("^/api/tasks/([a-f0-9-]{8,64})/events$", "i"));
    if (taskEventsMatch) {
      const taskSession = sessionFor(req);
      if (!taskSession) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      if (typeof taskManager.subscribe !== "function") return reply(res, 501, { error: "Task events are not available" });
      const task = taskManager.get(taskEventsMatch[1], taskSession.key);
      if (!task) return reply(res, 404, { error: "Task not found" });
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.write("retry: 2000\n\n");
      let closed = false;
      const keepAlive = setInterval(() => {
        try { res.write(": keep-alive\n\n"); } catch { /* the client is gone */ }
      }, 15_000);
      let unsubscribe = null;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        try { if (typeof unsubscribe === "function") unsubscribe(); } catch { /* already unsubscribed */ }
        try { res.end(); } catch { /* already closed */ }
      };
      const send = event => {
        try { res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); } catch { /* the client is gone */ }
        // A final event ends the stream.
        if (event.type === "done" || event.type === "error") close();
      };
      unsubscribe = taskManager.subscribe(taskEventsMatch[1], send);
      if (typeof unsubscribe !== "function") {
        send({ type: "error", at: new Date().toISOString(), data: { message: "事件流已满，请稍后重试。" } });
        close();
        return undefined;
      }
      res.on("close", close);
      return undefined;
    }
    const taskMatch = url.pathname.match(new RegExp("^/api/tasks/([a-f0-9-]{8,64})$", "i"));
    if (taskMatch) {
      const taskSession = sessionFor(req);
      if (!taskSession) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      const task = taskManager.get(taskMatch[1], taskSession.key);
      return task ? reply(res, 200, { task }) : reply(res, 404, { error: "Task not found" });
    }
    if (url.pathname === "/api/actions/pending") {
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      return reply(res, 200, { actions: actionApprovals.list(active.key) });
    }
    const actionDecisionMatch = url.pathname.match(/^\/api\/actions\/([a-f0-9-]{8,64})\/(confirm|deny)$/i);
    if (actionDecisionMatch) {
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      await jsonBody(req);
      const [, actionId, decision] = actionDecisionMatch;
      if (decision === "deny") {
        const revoked = actionApprovals.revoke(actionId, active.key);
        if (!revoked) return reply(res, 404, { error: "Pending action not found or expired" });
        if (revoked.taskId) taskManager.resolveApproval(revoked.taskId, { status: "cancelled", error: "操作已被拒绝，任务未执行。" });
        return reply(res, 200, { denied: true, actionId });
      }
      try {
        const confirmed = await actionApprovals.confirm(actionId, active.key);
        if (confirmed?.action?.taskId) taskManager.resolveApproval(confirmed.action.taskId, { status: "completed", result: confirmed.result });
        return reply(res, 200, { confirmed: true, ...confirmed });
      }
      catch (error) {
        const status = [403, 404, 409, 429].includes(error?.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: status === 500 ? "Unable to execute confirmed action" : error.message });
      }
    }
    if (url.pathname === "/api/mcp/status") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      const status = mcpManager.status();
      return reply(res, 200, {
        servers: status.servers,
        errors: [...mcpConfig.errors.map(item => ({ error: item.error })), ...status.errors],
        sources: toolRegistry.sources()
      });
    }
    if (url.pathname === "/api/agent/trace") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (req.method !== "GET") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
      const requested = Number(url.searchParams.get("limit"));
      const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 500) : 100;
      // The trace only holds metadata. Arguments, results and error messages
      // never reach this endpoint. The observer adds the live view of the last
      // calls: one terminal record per call, including the calls that the
      // execution policy denied.
      return reply(res, 200, {
        summary: toolTracer.summary(),
        entries: toolTracer.list().slice(-limit),
        observer: { summary: toolObserver.summary(), records: toolObserver.listRecords(limit) }
      });
    }
    if (url.pathname === "/api/tools") {
      if (!sessionFor(req)) return reply(res, 401, { error: "Unauthorized" });
      if (req.method === "GET") {
        let cliAvailable = false;
        try { cliAvailable = (await trimCli.status()).available; } catch { /* unavailable providers stay disabled in the UI */ }
        const tools = toolRegistry.list().map(tool =>
          tool.id.startsWith("fnos.") ? { ...tool, providerAvailable: cliAvailable } : tool
        );
        return reply(res, 200, {
          tools,
          executionEnabled: false,
          executionMode: executionPolicy.mode(),
          readOnlyExecutionEnabled: true,
          routineWriteExecutionEnabled: executionPolicy.mode() === "normal",
          destructiveActionConfirmationEnabled: true,
          trimCliProviderAvailable: cliAvailable,
          toolSources: toolRegistry.sources()
        });
      }
      return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "GET" });
    }
    const toolRunMatch = url.pathname.match(/^\/api\/tools\/([a-z][a-z0-9.:_-]{0,127})\/run$/);
    if (toolRunMatch) {
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed" }, "application/json; charset=utf-8", { allow: "POST" });
      const active = sessionFor(req);
      if (!active) return reply(res, 401, { error: "Unauthorized" });
      if (!sameOrigin(req)) return reply(res, 403, { error: "Forbidden origin" });
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
        return reply(res, 415, { error: "Expected application/json" });
      if (!toolRunLimiter.allow(active.key))
        return reply(res, 429, { error: "Too many tool runs; try again shortly." }, "application/json; charset=utf-8", { "retry-after": "60" });
      const args = await jsonBody(req);
      const tool = toolRegistry.list().find(item => item.id === toolRunMatch[1]);
      if (!tool) return reply(res, 404, { error: "Unknown tool" });
      const decision = executionPolicy.evaluate({ risk: tool.risk, approved: false });
      if (!decision.allowed) {
        if (decision.requiresApproval === true) {
          try {
            const approval = actionApprovals.request({ toolId: tool.id, args, sessionId: active.key });
            return reply(res, 202, { approvalRequired: true, approval, message: "This action needs an explicit confirmation." });
          } catch (error) {
            const status = [400, 409, 429].includes(error?.statusCode) ? error.statusCode : 500;
            return reply(res, status, { error: status === 500 ? "Unable to request approval" : error.message });
          }
        }
        return reply(res, decision.statusCode || 403, { error: policyMessage(decision) });
      }
      try { return reply(res, 200, { tool: toolRunMatch[1], result: await toolRegistry.invoke(toolRunMatch[1], args) }); }
      catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        return reply(res, status, { error: status === 500 ? "Tool execution failed" : error.message });
      }
    }
    return reply(res, 404, { error: "Not found" });
  } catch (error) {
    const body = { error: error.statusCode ? error.message : "Internal server error" };
    if (typeof error.errorCategory === "string") body.errorCategory = error.errorCategory;
    if (typeof error.connectionStatus === "string") body.connectionStatus = error.connectionStatus;
    if (typeof error.nextAction === "string") body.nextAction = error.nextAction;
    if (typeof error.code === "string" && /^TRIM_CLI_[A-Z0-9_]{1,64}$/.test(error.code)) body.code = error.code;
    return reply(res, error.statusCode || 500, body);
  }
});
await loadPassword();
await loadSessions();
if (skillStore) {
  try { await skillStore.load(); }
  catch (error) { console.error("Skill inventory unavailable; the agent started without a skill inventory:", error?.message || error); }
}
if (modelProviderStore) {
  try { await modelProviderStore.load(); }
  catch { console.error("Model settings unavailable; managed model providers were disabled."); }
}
try { await taskManager.ready; }
catch (error) { console.error("Task history unavailable; the agent started without task history:", error?.message || error); }
if (scheduledHealthChecks) {
  try { await scheduledHealthChecks.ready; scheduledHealthChecks.start(); }
  catch (error) { console.error("Scheduled health checks unavailable; the agent started without scheduler:", error?.message || error); }
}
await ensureSetupCode();
// The state file can also be edited out of band (for example over SSH), so the
// in-memory mode is refreshed on a timer. The timer never keeps the process alive.
const executionModeWatcher = setInterval(() => {
  try { void Promise.resolve(executionPolicy.reload()).catch(() => {}); } catch { /* keep the last known mode */ }
}, 5_000);
executionModeWatcher.unref?.();
// First-run setup is available on the trusted LAN; no NAS commands or Skills execute in this version.
const listenHost = process.env.HOST || "0.0.0.0";
server.on("error", error => { console.error("HTTP server error:", error?.message || error); });
server.listen(port, listenHost, () => console.log(`fnos-nas-agent listening on ${listenHost}:${port}; execution mode ${executionPolicy.mode()}; registered tools enabled, arbitrary shell and imported Skill execution disabled`));
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  scheduledHealthChecks?.stop();
  server.close(() => { void Promise.all([auditLogger?.flush(), taskManager.flush()]).finally(() => process.exit(0)); });
  // Idle connections close right away; in-flight requests get a short grace
  // period before the process is forced to exit.
  server.closeIdleConnections?.();
  setTimeout(() => server.closeAllConnections?.(), 3000).unref();
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", error => { console.error("Uncaught exception:", error?.stack || error); });
process.on("unhandledRejection", reason => { console.error("Unhandled rejection:", reason?.stack || reason); });

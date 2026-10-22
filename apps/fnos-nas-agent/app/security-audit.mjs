// Security inspection and audit reporting.
//
// This module is deliberately free of I/O: it never reads the audit file, never
// touches the file system and never talks to a model. Every conclusion is
// derived from the data that the caller passes in, so the report can be
// produced from a snapshot (a test, a cached file, a live request) and the
// result is the same. When the caller passes no data the module reports "no
// finding" instead of inventing one.
//
// It covers three user facing requirements:
//   SEC03  the tool permission table   -> buildToolPermissionTable()
//   SEC17  the security inspection      -> runSecurityInspection()
//   SEC18  the audit report             -> summarizeAuditEntries()
//   O06    the error aggregation        -> summarizeAuditEntries().repeatedErrors
//
// The module never grants, widens or executes anything. It only describes what
// the caller already knows.

const RISK_LEVELS = Object.freeze(["read-only", "write", "destructive"]);
const DEFAULT_APPROVAL_REQUIRED = Object.freeze(["destructive"]);
const SEVERITIES = Object.freeze(["critical", "warning", "info"]);
const SEVERITY_ORDER = Object.freeze({ critical: 0, warning: 1, info: 2 });

// A key name that suggests the value is a credential rather than a setting.
const SECRET_KEY_PATTERN = /(api[-_]?key|secret|password|passwd|token|credential|private[-_]?key|app[-_]?key)/i;
// A value that is only a pointer to the real secret, never the secret itself.
const SECRET_REFERENCE_PATTERN = /^(env:|file:|path:|ref:|vault:|secret:|\$\{|\$\(|<)/i;

// Values that mean "listen on every interface".
const EXPOSED_ADDRESSES = Object.freeze(["0.0.0.0", "::", "[::]", "*", "all", "any"]);

const MAX_DETAIL_LENGTH = 300;
const MAX_MESSAGE_LENGTH = 160;
const MAX_TOOL_ID_LENGTH = 120;
const MAX_TOOL_DESCRIPTION_LENGTH = 200;
const MAX_SECRET_EVIDENCE_ITEMS = 20;
const MAX_RECENT_FAILURES = 50;
const MAX_EVIDENCE_LENGTH = 240;

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function clipped(value, max) {
  const raw = text(value);
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/**
 * Resolves the action name of an audit entry. The audit log writes `route`,
 * but a caller may hand over `action` or a plain `method`.
 *
 * @param {object} entry
 * @returns {string}
 */
function actionOf(entry) {
  return clipped(entry?.action ?? entry?.route ?? entry?.method ?? "other", MAX_TOOL_ID_LENGTH) || "other";
}

/**
 * Resolves the outcome of an audit entry. Anything that is not an explicit
 * success is treated as a failure, so an unknown value never hides a problem.
 *
 * @param {object} entry
 * @returns {string}
 */
function outcomeOf(entry) {
  const raw = text(entry?.outcome).toLowerCase();
  if (!raw) {
    const statusCode = Number(entry?.statusCode);
    if (Number.isInteger(statusCode)) return statusCode < 400 ? "success" : statusCode < 500 ? "rejected" : "error";
    return "unknown";
  }
  return raw;
}

/**
 * Resolves the human readable detail of an audit entry.
 *
 * @param {object} entry
 * @returns {string}
 */
function detailOf(entry) {
  const raw = entry?.detail ?? entry?.message ?? entry?.error ?? entry?.reason ?? entry?.summary ?? "";
  return clipped(raw, MAX_DETAIL_LENGTH);
}

/**
 * Normalizes an error message so that entries which differ only by a number, a
 * timestamp or a quoted identifier collapse into one group.
 *
 * @param {unknown} value
 * @returns {string} the normalized message, or "" when nothing usable is left
 */
export function normalizeErrorMessage(value) {
  let message = text(value);
  if (!message) return "";
  // Quoted fragments carry identifiers that differ per request.
  message = message.replace(/["'“”‘’][^"'“”‘’]*["'“”‘’]/g, "…");
  // ISO timestamps and clock times.
  message = message.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/gi, "…");
  message = message.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "…");
  // UUIDs and long hex identifiers.
  message = message.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "…");
  message = message.replace(/\b[0-9a-f]{12,}\b/gi, "…");
  // Every remaining number is a per request value.
  message = message.replace(/\d+/g, "…");
  message = message.replace(/\s+/g, " ").trim();
  // A message that consists only of placeholders carries no information.
  if (!/[A-Za-z]|[一-鿿]/.test(message)) return "";
  return clipped(message, MAX_MESSAGE_LENGTH);
}

/**
 * Masks a value that looks like a secret. Only the first two characters stay
 * readable so an operator can tell two keys apart; the rest is replaced by a
 * fixed number of asterisks, so the mask never reveals the length of the
 * secret either.
 *
 * @param {unknown} value
 * @returns {string} the masked value, or "" for an empty / non string input
 */
export function maskSecret(value) {
  const secret = text(value);
  if (!secret) return "";
  const visible = secret.slice(0, 2);
  return `${visible}${"*".repeat(8)}`;
}

/**
 * Summarizes audit entries into an audit report.
 *
 * The aggregation is stable: the same entries always produce the same groups,
 * and the groups are ordered by their count so the most frequent error comes
 * first. Only groups that happened at least twice are reported, because a
 * single occurrence is an incident rather than a pattern.
 *
 * @param {Array<object>} entries
 * @param {{limit?: number}} [options]
 * @returns {{total:number, byAction:object, byOutcome:object, repeatedErrors:Array<{message:string,count:number}>, recentFailures:Array<{at:string,action:string,outcome:string,detail:string}>}}
 */
export function summarizeAuditEntries(entries, { limit = 20 } = {}) {
  const list = Array.isArray(entries) ? entries.filter(item => item && typeof item === "object") : [];
  const max = Number.isInteger(limit) && limit >= 0 ? limit : 20;

  const byAction = Object.create(null);
  const byOutcome = Object.create(null);
  const groups = new Map();
  const failures = [];

  for (const entry of list) {
    const action = actionOf(entry);
    const outcome = outcomeOf(entry);
    byAction[action] = (byAction[action] || 0) + 1;
    byOutcome[outcome] = (byOutcome[outcome] || 0) + 1;

    const detail = detailOf(entry);
    if (outcome !== "success") {
      failures.push({
        at: clipped(entry?.at ?? entry?.timestamp ?? "", 64),
        action,
        outcome,
        detail
      });
    }
    if (outcome === "success") continue;
    const message = normalizeErrorMessage(detail);
    if (!message) continue;
    groups.set(message, (groups.get(message) || 0) + 1);
  }

  const repeatedErrors = [...groups.entries()]
    .filter(([, count]) => count >= 2)
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message))
    .slice(0, max);

  const recentFailures = failures
    .slice()
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, Math.min(max, MAX_RECENT_FAILURES));

  return {
    total: list.length,
    byAction: { ...byAction },
    byOutcome: { ...byOutcome },
    repeatedErrors,
    recentFailures
  };
}

/**
 * Normalizes the source of a tool. The registry stores an object
 * (`{id, kind, label}`) while a plain catalogue stores a string.
 *
 * @param {unknown} source
 * @returns {string}
 */
function sourceOf(source) {
  if (typeof source === "string") return source.trim();
  if (source && typeof source === "object") {
    return text(source.kind) || text(source.id) || text(source.label) || "unknown";
  }
  return "unknown";
}

/**
 * Normalizes one catalogue entry.
 *
 * @param {object} item
 * @returns {object|null}
 */
function normalizeTool(item) {
  if (!item || typeof item !== "object") return null;
  const id = clipped(item.id ?? item.tool ?? item.name, MAX_TOOL_ID_LENGTH);
  if (!id) return null;
  const risk = RISK_LEVELS.includes(item.risk) ? item.risk : "unknown";
  return {
    id,
    source: sourceOf(item.source),
    risk,
    description: clipped(item.description ?? item.title, MAX_TOOL_DESCRIPTION_LENGTH),
    title: clipped(item.title, MAX_TOOL_ID_LENGTH),
    requiresApproval: item.requiresApproval === undefined || item.requiresApproval === null
      ? null
      : item.requiresApproval === true
  };
}

/**
 * Reads the tool catalogue. Both an array and a `{tools: []}` wrapper are
 * accepted so the caller can pass the registry output directly.
 *
 * @param {Array<object>|{tools?: Array<object>}} catalog
 * @returns {Array<object>}
 */
function catalogEntries(catalog) {
  if (Array.isArray(catalog)) return catalog;
  if (catalog && typeof catalog === "object" && Array.isArray(catalog.tools)) return catalog.tools;
  return [];
}

/**
 * Builds the tool permission table (SEC03).
 *
 * The table is the answer to "which tool may do what, and does it need a
 * human". The approval requirement is derived from the risk level, and the
 * caller may widen or narrow that list.
 *
 * @param {Array<object>|{tools?: Array<object>}} catalog
 * @param {{approvalRequired?: Array<string>}} [options]
 * @returns {Array<{tool:string, source:string, risk:string, requiresApproval:boolean, description:string}>}
 */
export function buildToolPermissionTable(catalog, { approvalRequired = DEFAULT_APPROVAL_REQUIRED } = {}) {
  const required = new Set(
    (Array.isArray(approvalRequired) ? approvalRequired : DEFAULT_APPROVAL_REQUIRED)
      .map(item => text(item))
      .filter(Boolean)
  );
  const table = [];
  for (const raw of catalogEntries(catalog)) {
    const tool = normalizeTool(raw);
    if (!tool) continue;
    table.push({
      tool: tool.id,
      source: tool.source,
      risk: tool.risk,
      requiresApproval: required.has(tool.risk) || tool.requiresApproval === true,
      description: tool.description
    });
  }
  return table;
}

/**
 * Collects the configuration entries that look like a plaintext secret.
 *
 * @param {object} config
 * @param {string} [prefix]
 * @param {number} [depth]
 * @returns {Array<{path:string, value:string}>}
 */
function collectPlaintextSecrets(config, prefix = "config", depth = 0) {
  const found = [];
  if (!config || typeof config !== "object" || depth > 2) return found;
  for (const [key, value] of Object.entries(config)) {
    const path = `${prefix}.${key}`;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      found.push(...collectPlaintextSecrets(value, path, depth + 1));
      continue;
    }
    if (typeof value !== "string") continue;
    if (!SECRET_KEY_PATTERN.test(key)) continue;
    if (!value.trim()) continue;
    if (SECRET_REFERENCE_PATTERN.test(value.trim())) continue;
    if (value.trim().length < 8) continue;
    found.push({ path, value });
    if (found.length >= MAX_SECRET_EVIDENCE_ITEMS) return found;
  }
  return found;
}

/**
 * Decides whether a storage root is wider than a storage volume.
 *
 * @param {unknown} root
 * @returns {boolean}
 */
function isOverBroadRoot(root) {
  const value = text(root);
  if (!value) return false;
  if (value === "/" || value === "\\" || value === "*") return true;
  if (/^[A-Za-z]:[\\/]?$/.test(value)) return true;
  return false;
}

/**
 * Decides whether a scheduled health check failed.
 *
 * @param {object} check
 * @returns {boolean}
 */
function checkFailed(check) {
  if (!check || typeof check !== "object") return false;
  const status = text(check.lastStatus ?? check.status).toLowerCase();
  if (["error", "failed", "failure", "unhealthy"].includes(status)) return true;
  const last = check.lastResult ?? check.lastRun ?? check.result;
  if (last && typeof last === "object") {
    const lastStatus = text(last.status ?? last.outcome).toLowerCase();
    if (["error", "failed", "failure"].includes(lastStatus)) return true;
  }
  return false;
}

/**
 * Builds one inspection section.
 *
 * @param {string} id
 * @param {string} title
 * @param {Array<object>} findings
 * @returns {object}
 */
function section(id, title, findings) {
  const severity = findings.length
    ? findings.reduce((worst, finding) => (SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[worst] ? finding.severity : worst), "info")
    : "info";
  return { id, title, severity, summary: findings.length ? `${findings.length} 项待处理` : "未发现问题", findings };
}

/**
 * Runs the security inspection (SEC17).
 *
 * Every section is always present so the report has a stable shape, but a
 * section only carries findings when the passed data supports them. With no
 * input the report is empty rather than speculative.
 *
 * @param {{toolCatalog?: Array<object>, auditEntries?: Array<object>, config?: object, scheduledChecks?: Array<object>, storageRoots?: Array<string>}} [input]
 * @returns {{generatedAt:string, sections:Array<object>, summary:{critical:number, warning:number, info:number, total:number}}}
 */
export function runSecurityInspection({ toolCatalog, auditEntries, config = {}, scheduledChecks = [], storageRoots = [] } = {}) {
  const settings = config && typeof config === "object" ? config : {};
  const checks = Array.isArray(scheduledChecks) ? scheduledChecks : [];
  const roots = Array.isArray(storageRoots) ? storageRoots : [];

  const sections = [];

  /* --- exposed-listen-address -------------------------------------- */
  {
    const address = text(settings.listenAddress ?? settings.host ?? settings.bindAddress ?? settings.address);
    const findings = [];
    if (address && EXPOSED_ADDRESSES.includes(address.toLowerCase())) {
      findings.push({
        id: "exposed-listen-address:binding",
        title: "服务监听在所有网络接口上",
        detail: `监听地址 ${address} 会把管理接口暴露给同网段的任意主机。`,
        evidence: `config.listenAddress = ${address}`,
        recommendation: "改为 127.0.0.1 或具体内网地址，并通过反向代理对外提供服务。",
        severity: "warning"
      });
    }
    sections.push(section("exposed-listen-address", "监听地址暴露面", findings));
  }

  /* --- plaintext-secret-config ------------------------------------- */
  {
    const secrets = collectPlaintextSecrets(settings);
    const findings = secrets.map((item, index) => ({
      id: `plaintext-secret-config:${index + 1}`,
      title: `配置项 ${item.path} 保存了明文凭据`,
      detail: "该配置项的值是一个明文密钥，而不是指向密钥来源的引用。",
      evidence: `${item.path} = ${maskSecret(item.value)}`,
      recommendation: "改为引用环境变量或密钥文件，并在配置中只保留引用路径。",
      severity: "critical"
    }));
    sections.push(section("plaintext-secret-config", "配置中的明文凭据", findings));
  }

  /* --- destructive-tool-without-approval --------------------------- */
  {
    const catalog = catalogEntries(toolCatalog);
    const destructive = catalog.map(normalizeTool).filter(tool => tool && tool.risk === "destructive");
    const configured = Array.isArray(settings.approvalRequired) ? settings.approvalRequired.map(text) : null;
    const findings = [];
    if (destructive.length && configured && !configured.includes("destructive")) {
      findings.push({
        id: "destructive-tool-without-approval:policy",
        title: "破坏性工具未列入需确认清单",
        detail: "执行策略的需确认清单里没有 destructive，破坏性工具可以不经一次性确认直接运行。",
        evidence: `config.approvalRequired = [${configured.map(item => item || "").join(", ")}]；破坏性工具 ${destructive.length} 个`,
        recommendation: "把 destructive 加回需确认清单，让破坏性调用重新回到一次性确认流程。",
        severity: "critical"
      });
    }
    for (const tool of destructive) {
      if (tool.requiresApproval !== false) continue;
      findings.push({
        id: `destructive-tool-without-approval:${tool.id}`,
        title: `工具 ${tool.id} 声明自己不需要确认`,
        detail: "该工具的风险级别是 destructive，却显式声明无需确认。",
        evidence: `tool ${tool.id} (source ${tool.source}) risk=destructive requiresApproval=false`,
        recommendation: "移除该声明，或把该工具的风险级别下调为 write。",
        severity: "critical"
      });
    }
    sections.push(section("destructive-tool-without-approval", "破坏性工具的确认要求", findings));
  }

  /* --- over-broad-file-root ---------------------------------------- */
  {
    const broad = roots.filter(isOverBroadRoot);
    const findings = broad.map((root, index) => ({
      id: `over-broad-file-root:${index + 1}`,
      title: "文件根目录覆盖了整个文件系统",
      detail: "配置的存储根目录是文件系统根目录，文件域操作会作用到系统盘。",
      evidence: `storageRoots 包含 ${root}`,
      recommendation: "把根目录收窄到具体存储卷（例如 /vol1），不要包含文件系统根。",
      severity: "critical"
    }));
    sections.push(section("over-broad-file-root", "文件根目录范围", findings));
  }

  /* --- scheduled-check-failure ------------------------------------- */
  {
    const failed = checks.filter(checkFailed);
    const findings = failed.map((check, index) => ({
      id: `scheduled-check-failure:${index + 1}`,
      title: `定时巡检 ${text(check.name) || text(check.id) || "未命名"} 上次执行失败`,
      detail: "该定时巡检的最近一次结果为失败状态。",
      evidence: `check ${text(check.id) || "(no id)"} lastStatus=${text(check.lastStatus ?? check.status) || "unknown"}`,
      recommendation: "查看该巡检的历史记录并修复失败原因；连续失败的巡检应先停用。",
      severity: "warning"
    }));
    sections.push(section("scheduled-check-failure", "定时巡检失败", findings));
  }

  /* --- repeated-audit-failure -------------------------------------- */
  {
    const summary = summarizeAuditEntries(auditEntries);
    const findings = summary.repeatedErrors.map((group, index) => ({
      id: `repeated-audit-failure:${index + 1}`,
      title: "同一错误重复出现",
      detail: "该错误在审计记录中重复出现，属于可归并的失败模式。",
      evidence: `audit entries: ${group.message} × ${group.count}（共 ${summary.total} 条记录）`,
      recommendation: "按错误聚合结果定位根因，修复后确认计数回落。",
      severity: "warning"
    }));
    sections.push(section("repeated-audit-failure", "重复失败聚合", findings));
  }

  const all = sections.flatMap(item => item.findings);
  const summary = { critical: 0, warning: 0, info: 0, total: all.length };
  for (const finding of all) {
    if (finding.severity === "critical") summary.critical += 1;
    else if (finding.severity === "warning") summary.warning += 1;
    else summary.info += 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    sections,
    summary
  };
}

export const SECURITY_AUDIT_SECTION_IDS = Object.freeze([
  "exposed-listen-address",
  "plaintext-secret-config",
  "destructive-tool-without-approval",
  "over-broad-file-root",
  "scheduled-check-failure",
  "repeated-audit-failure"
]);

export const SEVERITY_LEVELS = SEVERITIES;

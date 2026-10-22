/**
 * Overview service.
 *
 * The new mobile-first UI needs a single request for every headline metric
 * instead of six parallel API calls. This module aggregates the already
 * existing services into one JSON-serialisable snapshot.
 *
 * Every dependency is optional and every upstream call is defensive: a missing
 * service, a missing method, or a throwing method must never break the
 * overview. `snapshot()` therefore never throws and always returns the full
 * shape with safe defaults.
 *
 * The snapshot only carries counters and identifiers. No key, token, secret or
 * absolute path is ever copied into it.
 */
import { APP_VERSION } from "./version.mjs";

const DEFAULT_EXECUTION_MODES = Object.freeze(["normal", "read-only", "halted"]);
const DEFAULT_TASK_CONCURRENCY = 2;

/**
 * Calls `owner[method]` when it exists and is callable, swallowing any error.
 * Returns undefined when the method is missing or fails.
 */
function safeCall(owner, method, ...args) {
  if (!owner) return undefined;
  const fn = owner[method];
  if (typeof fn !== "function") return undefined;
  try {
    return fn.call(owner, ...args);
  } catch (error) {
    console.error(`[overview] ${method}() failed:`, error?.message || error);
    return undefined;
  }
}

/** Reads a property without throwing on exotic proxies or getters. */
function safeGet(owner, key) {
  if (!owner) return undefined;
  try {
    return owner[key];
  } catch (error) {
    console.error(`[overview] reading ${key} failed:`, error?.message || error);
    return undefined;
  }
}

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function toStringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

/** Resolves a health-like payload from an object or a factory function. */
function readHealth(health) {
  const payload = typeof health === "function" ? safeCall({ fn: health }, "fn") : health;
  if (!payload || typeof payload !== "object") return {};
  return payload;
}

function readExecution(executionPolicy) {
  const mode = toStringOrEmpty(safeCall(executionPolicy, "mode")) || "normal";
  const source = toStringOrEmpty(safeCall(executionPolicy, "source")) || "default";
  let modes = safeCall(executionPolicy, "modes");
  if (!Array.isArray(modes)) {
    const raw = safeGet(executionPolicy, "modes");
    modes = Array.isArray(raw) ? raw : undefined;
  }
  if (!Array.isArray(modes) || !modes.length) modes = [...DEFAULT_EXECUTION_MODES];
  return { mode, source, modes: modes.filter(item => typeof item === "string") };
}

function readTasks(taskManager) {
  const stats = safeCall(taskManager, "stats");
  const queued = toCount(safeGet(stats, "queued"));
  const running = toCount(safeGet(stats, "running"));
  const retained = toCount(safeGet(stats, "retained"));
  const concurrency = toCount(safeGet(stats, "concurrency")) || DEFAULT_TASK_CONCURRENCY;
  if (stats && typeof stats === "object") return { queued, running, retained, concurrency };

  // Some task managers only expose a task list; derive the counters from it.
  const listed = safeCall(taskManager, "list");
  const items = Array.isArray(listed) ? listed : Array.isArray(safeGet(listed, "tasks")) ? safeGet(listed, "tasks") : [];
  if (!items.length) return { queued, running, retained, concurrency };
  let derivedQueued = 0;
  let derivedRunning = 0;
  for (const item of items) {
    const status = toStringOrEmpty(safeGet(item, "status"));
    if (status === "queued") derivedQueued += 1;
    if (status === "running") derivedRunning += 1;
  }
  return {
    queued: queued || derivedQueued,
    running: running || derivedRunning,
    retained: retained || items.length,
    concurrency
  };
}

function readSkills(skillStore) {
  // A wide page keeps the state counters accurate for stores that paginate.
  let list = safeCall(skillStore, "list", { limit: 200, offset: 0 });
  if (list === undefined) list = safeCall(skillStore, "list");
  let items = Array.isArray(list) ? list : null;
  if (!items) {
    const nested = safeGet(list, "skills");
    if (Array.isArray(nested)) items = nested;
  }
  if (!items) {
    const snapshot = safeCall(skillStore, "snapshot");
    const nested = safeGet(snapshot, "skills");
    if (Array.isArray(nested)) items = nested;
  }
  if (!items) {
    const snapshot = safeCall(skillStore, "snapshot");
    const nested = safeGet(snapshot, "items");
    if (Array.isArray(nested)) items = nested;
  }
  if (!items) items = [];

  let pendingReview = 0;
  let enabled = 0;
  for (const item of items) {
    const state = toStringOrEmpty(safeGet(item, "state"));
    if (state === "pending_review") pendingReview += 1;
    if (state === "enabled") enabled += 1;
  }
  const declaredTotal = toCount(safeGet(list, "total"));
  return { total: declaredTotal || items.length, pendingReview, enabled };
}

function readModels(modelProviderStore) {
  const listed = safeCall(modelProviderStore, "list");
  let providers = Array.isArray(listed) ? listed : null;
  if (!providers) {
    const nested = safeGet(listed, "providers");
    if (Array.isArray(nested)) providers = nested;
  }
  if (!providers) {
    const status = safeCall(modelProviderStore, "status");
    const nested = safeGet(status, "providers");
    if (Array.isArray(nested)) providers = nested;
  }
  if (!providers) providers = [];

  let activeProviderId = safeGet(listed, "activeProviderId");
  if (typeof activeProviderId !== "string") {
    const status = safeCall(modelProviderStore, "status");
    const fromStatus = safeGet(status, "activeProviderId");
    if (typeof fromStatus === "string") activeProviderId = fromStatus;
  }
  if (typeof activeProviderId !== "string" || !activeProviderId) {
    const runtime = safeCall(modelProviderStore, "runtimeConfig");
    const fromRuntime = safeGet(runtime, "providerId");
    if (typeof fromRuntime === "string" && fromRuntime) activeProviderId = fromRuntime;
  }
  if (typeof activeProviderId !== "string" || !activeProviderId) activeProviderId = null;

  let providerCount = providers.length;
  if (!providerCount) {
    const status = safeCall(modelProviderStore, "status");
    providerCount = toCount(safeGet(status, "providerCount"));
  }

  let enabled = false;
  const runtime = safeCall(modelProviderStore, "runtimeConfig");
  if (runtime && typeof runtime === "object" && typeof safeGet(runtime, "enabled") === "boolean") {
    enabled = safeGet(runtime, "enabled") === true;
  } else {
    const active = providers.find(item => safeGet(item, "id") === activeProviderId);
    if (active) enabled = safeGet(active, "enabled") === true && safeGet(active, "hasApiKey") !== false;
  }

  return { providerCount, activeProviderId, enabled };
}

function readApprovals(actionApprovals) {
  const listed = safeCall(actionApprovals, "list");
  if (Array.isArray(listed)) return { pending: listed.length };
  const actions = safeGet(listed, "actions");
  if (Array.isArray(actions)) return { pending: actions.length };
  const snapshot = safeCall(actionApprovals, "snapshot");
  const pending = safeGet(snapshot, "pending");
  if (typeof pending === "number" && Number.isFinite(pending)) return { pending: Math.max(0, Math.trunc(pending)) };
  return { pending: 0 };
}

function readAgent(agentCore, modelEnabled) {
  const status = safeCall(agentCore, "status");
  if (!status || typeof status !== "object") {
    return { rulesFirst: true, availableTools: 0, modelEnabled: modelEnabled === true };
  }
  const model = safeGet(status, "model");
  const modelStatus = model && typeof model === "object" ? safeGet(model, "enabled") : safeGet(status, "modelEnabled");
  let availableTools = toCount(safeGet(status, "availableTools"));
  if (!availableTools) {
    const tools = safeCall(safeGet(agentCore, "tools"), "list");
    if (Array.isArray(tools)) availableTools = tools.length;
  }
  return {
    rulesFirst: safeGet(status, "rulesFirst") === false ? false : true,
    availableTools,
    modelEnabled: typeof modelStatus === "boolean" ? modelStatus : modelEnabled === true
  };
}

/**
 * Creates the overview service.
 *
 * @param {object} [options]
 * @param {object|Function} [options.health] Health payload or factory.
 * @param {object} [options.executionPolicy] Execution policy service.
 * @param {object} [options.taskManager] Task manager service.
 * @param {object} [options.skillStore] Skill store service.
 * @param {object} [options.modelProviderStore] Model provider store service.
 * @param {object} [options.actionApprovals] Action approval service.
 * @param {object} [options.agentCore] Agent core service.
 * @param {Function} [options.now] Clock, returns milliseconds.
 * @returns {{ snapshot: () => object }}
 */
export function createOverviewService({
  health,
  executionPolicy,
  taskManager,
  skillStore,
  modelProviderStore,
  actionApprovals,
  agentCore,
  now = () => Date.now()
} = {}) {
  function snapshot() {
    const healthPayload = readHealth(health);
    const version = toStringOrEmpty(safeGet(healthPayload, "version")) || APP_VERSION;
    const ok = safeGet(healthPayload, "ok");
    const degraded = safeGet(healthPayload, "degraded");
    const degradedComponents = safeGet(healthPayload, "degradedComponents");
    const isOk = typeof ok === "boolean" ? ok : true;
    const isDegraded = typeof degraded === "boolean" ? degraded : !isOk;
    const components = Array.isArray(degradedComponents)
      ? degradedComponents.filter(item => typeof item === "string")
      : [];

    const execution = readExecution(executionPolicy);
    const tasks = readTasks(taskManager);
    const skills = readSkills(skillStore);
    const models = readModels(modelProviderStore);
    const approvals = readApprovals(actionApprovals);
    const agent = readAgent(agentCore, models.enabled);

    let generatedAt;
    try {
      generatedAt = new Date(now()).toISOString();
    } catch (error) {
      console.error("[overview] clock failed:", error?.message || error);
      generatedAt = new Date(0).toISOString();
    }

    return {
      generatedAt,
      app: { name: "fnos-nas-agent", version },
      health: { ok: isOk, degraded: isDegraded, degradedComponents: components },
      execution,
      tasks,
      skills,
      models,
      approvals,
      agent
    };
  }

  return { snapshot };
}

export default createOverviewService;

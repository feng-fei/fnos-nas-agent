// Model usage metering: call counters, token accounting, estimated cost,
// model capability description and privacy mode.
//
// Phase 165 of the Marvis migration tool set. It serves the "local model,
// cloud model and privacy mode" feature block:
//   AI05 - privacy mode: a cloud provider request is not allowed to leave the
//          NAS while privacy mode is on.
//   AI07 - model capabilities: context window, tool calling, streaming and
//          structured output support are described, and an unknown capability
//          stays unknown instead of being guessed.
//   AI08 - call cost statistics: request counters, token counters and an
//          estimated cost derived from an operator supplied price table.
//
// The module is deliberately free of I/O, network access and global state:
// everything lives in the closure of createUsageMeter() and the memory is
// bounded by maxEntries. There is no third party dependency.
const DEFAULT_MAX_ENTRIES = 1000;
const MAX_TEXT_LENGTH = 160;
const MAX_TOKEN_VALUE = 1_000_000_000;
const COST_DECIMALS = 6;
const CURRENCY = "USD";
const COST_UNIT = "per-1k-tokens";
const LOOPBACK_HOSTS = new Set(["localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);

function fail(message) {
  throw new TypeError(message);
}

function text(value, max = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return "";
  return trimmed;
}

// A counter is a non negative integer. Anything else - a float, a negative
// number, a string, a missing value - counts as zero instead of poisoning the
// totals with NaN.
function count(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  const whole = Math.floor(value);
  return whole > MAX_TOKEN_VALUE ? MAX_TOKEN_VALUE : whole;
}

function unitPrice(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function round(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const factor = 10 ** COST_DECIMALS;
  return Math.round(value * factor) / factor;
}

function isLoopbackEndpoint(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  let parsed = null;
  try { parsed = new URL(value); } catch { return false; }
  const host = parsed.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

// The price table is keyed by model id. The lookup is exact first, then case
// insensitive, because providers are inconsistent about the casing of their
// model names.
function priceFor(priceTable, model) {
  if (!priceTable || typeof priceTable !== "object" || Array.isArray(priceTable)) return null;
  if (typeof model !== "string" || !model) return null;
  const direct = priceTable[model];
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
  const lowered = model.toLowerCase();
  for (const key of Object.keys(priceTable)) {
    if (key.toLowerCase() !== lowered) continue;
    const value = priceTable[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return null;
}

function normalizeEntry(entry, nowFn, localProviders) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const provider = text(entry.provider);
  // A record without a provider cannot be attributed to any model, so it is
  // dropped instead of being counted as an anonymous request.
  if (!provider) return null;
  const model = text(entry.model);
  const outcome = entry.outcome === "ok" ? "ok" : "error";
  const local = entry.local === true
    || isLoopbackEndpoint(entry.endpoint)
    || localProviders.has(provider.toLowerCase());
  let at = 0;
  try {
    const stamp = nowFn();
    if (typeof stamp === "number" && Number.isFinite(stamp)) at = stamp;
  } catch { at = 0; }
  return {
    provider,
    model,
    outcome,
    privacyMode: entry.privacyMode === true,
    local,
    promptTokens: count(entry.promptTokens),
    completionTokens: count(entry.completionTokens),
    latencyMs: count(entry.latencyMs),
    at
  };
}

/**
 * Estimate the cost of one model call.
 *
 * @param {{model?: string, promptTokens?: number, completionTokens?: number, priceTable?: object}} options
 * @returns {{cost: number, currency: string, priced: boolean, unit: string}}
 */
export function estimateCost({ model, promptTokens = 0, completionTokens = 0, priceTable = {} } = {}) {
  const input = count(promptTokens);
  const output = count(completionTokens);
  const price = priceFor(priceTable, model);
  if (!price) return { cost: 0, currency: CURRENCY, priced: false, unit: COST_UNIT };
  const inputPer1k = unitPrice(price.inputPer1k);
  const outputPer1k = unitPrice(price.outputPer1k);
  // A price entry is only usable when both sides are known. A half known
  // price would silently under-report the cost of the turn.
  if (inputPer1k === null || outputPer1k === null) {
    return { cost: 0, currency: CURRENCY, priced: false, unit: COST_UNIT };
  }
  const cost = (input / 1000) * inputPer1k + (output / 1000) * outputPer1k;
  return { cost: round(cost), currency: CURRENCY, priced: true, unit: COST_UNIT };
}

/**
 * Describe what a model can do. Every capability that the operator did not
 * declare stays false, and every unknown identity stays null, so the UI can
 * render "unknown" instead of claiming a capability that was never verified.
 *
 * @param {{id?: string, provider?: string, contextWindow?: number, capabilities?: {tools?: boolean, streaming?: boolean, structuredOutput?: boolean}, local?: boolean}} entry
 * @returns {{id: string|null, provider: string|null, contextWindow: number|null, supportsTools: boolean, supportsStreaming: boolean, supportsStructuredOutput: boolean, privacyLocal: boolean}}
 */
export function describeModelCapabilities(entry) {
  const source = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
  const capabilities = source.capabilities && typeof source.capabilities === "object" && !Array.isArray(source.capabilities)
    ? source.capabilities
    : {};
  const contextWindow = Number.isInteger(source.contextWindow) && source.contextWindow > 0 ? source.contextWindow : null;
  return Object.freeze({
    id: text(source.id) || null,
    provider: text(source.provider) || null,
    contextWindow,
    supportsTools: capabilities.tools === true,
    supportsStreaming: capabilities.streaming === true,
    supportsStructuredOutput: capabilities.structuredOutput === true,
    privacyLocal: source.local === true
  });
}

/**
 * Apply privacy mode to a usage summary.
 *
 * The privacy decision is expressed with two counters:
 *   - cloudRequestsBlocked: how many cloud requests privacy mode refused.
 *   - cloudRequestsAllowed: how many requests may still leave the NAS. A
 *     request to a cloud provider contributes 0 to it while privacy mode is
 *     on, a request to a local provider is never blocked.
 * With privacy mode off nothing is blocked and every request stays allowed.
 *
 * @param {object} summary
 * @param {{privacyMode?: boolean}} options
 */
export function applyPrivacyMode(summary, { privacyMode } = {}) {
  const base = summary && typeof summary === "object" && !Array.isArray(summary) ? summary : {};
  const requests = count(base.requests);
  const localRequests = count(base.localRequests);
  // An unknown breakdown is treated as "everything was cloud", which is the
  // conservative answer for a privacy decision.
  const cloudRequests = typeof base.cloudRequests === "number" && Number.isFinite(base.cloudRequests)
    ? count(base.cloudRequests)
    : Math.max(0, requests - localRequests);
  const enabled = privacyMode === true;
  const blocked = enabled ? cloudRequests : 0;
  return Object.freeze({
    ...base,
    privacyMode: enabled,
    cloudRequestsAllowed: requests - blocked,
    cloudRequestsBlocked: blocked
  });
}

/**
 * Create a bounded usage meter.
 *
 * @param {{maxEntries?: number, now?: () => number, priceTable?: object, localProviders?: string[]}} options
 */
export function createUsageMeter({ maxEntries = DEFAULT_MAX_ENTRIES, now = () => Date.now(), priceTable = {}, localProviders = [] } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) fail("maxEntries must be a positive integer");
  if (typeof now !== "function") fail("now must be a function");
  const table = priceTable && typeof priceTable === "object" && !Array.isArray(priceTable) ? priceTable : {};
  const localNames = new Set();
  if (Array.isArray(localProviders)) {
    for (const name of localProviders) {
      const value = text(name);
      if (value) localNames.add(value.toLowerCase());
    }
  }
  const buffer = [];

  function resolveTable(options) {
    if (options && typeof options === "object" && !Array.isArray(options) &&
        options.priceTable && typeof options.priceTable === "object" && !Array.isArray(options.priceTable)) {
      return options.priceTable;
    }
    return table;
  }

  function record(entry) {
    const normalized = normalizeEntry(entry, now, localNames);
    if (!normalized) return null;
    buffer.push(normalized);
    // The oldest entry is dropped first, so the memory stays bounded.
    while (buffer.length > maxEntries) buffer.shift();
    return Object.freeze({ ...normalized });
  }

  function summary(options = {}) {
    const prices = resolveTable(options);
    let requests = 0, ok = 0, error = 0;
    let promptTokens = 0, completionTokens = 0, latencyTotal = 0;
    let localRequests = 0, cloudRequests = 0, privacyModeRequests = 0;
    let cost = 0, allPriced = true;
    const unpricedModels = new Set();
    for (const item of buffer) {
      requests += 1;
      if (item.outcome === "ok") ok += 1; else error += 1;
      promptTokens += item.promptTokens;
      completionTokens += item.completionTokens;
      latencyTotal += item.latencyMs;
      if (item.local) localRequests += 1; else cloudRequests += 1;
      if (item.privacyMode) privacyModeRequests += 1;
      const priced = estimateCost({
        model: item.model,
        promptTokens: item.promptTokens,
        completionTokens: item.completionTokens,
        priceTable: prices
      });
      if (priced.priced) cost += priced.cost;
      else {
        allPriced = false;
        unpricedModels.add(item.model || "unknown");
      }
    }
    return Object.freeze({
      requests,
      ok,
      error,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimatedCost: round(cost),
      // priced is false as soon as one recorded call had no usable price, so
      // the UI can show the estimate as incomplete instead of exact.
      priced: requests > 0 && allPriced,
      byOutcome: Object.freeze({ ok, error }),
      localRequests,
      cloudRequests,
      privacyModeRequests,
      averageLatencyMs: requests ? round(latencyTotal / requests) : 0,
      unpricedModels: Object.freeze([...unpricedModels].sort())
    });
  }

  function byModel(options = {}) {
    const prices = resolveTable(options);
    const groups = new Map();
    for (const item of buffer) {
      const key = item.provider + "::" + item.model;
      let group = groups.get(key);
      if (!group) {
        group = {
          provider: item.provider, model: item.model, requests: 0, ok: 0, error: 0,
          promptTokens: 0, completionTokens: 0, latencyTotal: 0, cost: 0, priced: true,
          localRequests: 0, privacyModeRequests: 0
        };
        groups.set(key, group);
      }
      group.requests += 1;
      if (item.outcome === "ok") group.ok += 1; else group.error += 1;
      group.promptTokens += item.promptTokens;
      group.completionTokens += item.completionTokens;
      group.latencyTotal += item.latencyMs;
      if (item.local) group.localRequests += 1;
      if (item.privacyMode) group.privacyModeRequests += 1;
      const priced = estimateCost({
        model: item.model,
        promptTokens: item.promptTokens,
        completionTokens: item.completionTokens,
        priceTable: prices
      });
      if (priced.priced) group.cost += priced.cost; else group.priced = false;
    }
    return Object.freeze([...groups.values()].map(group => Object.freeze({
      provider: group.provider,
      model: group.model,
      requests: group.requests,
      ok: group.ok,
      error: group.error,
      promptTokens: group.promptTokens,
      completionTokens: group.completionTokens,
      totalTokens: group.promptTokens + group.completionTokens,
      estimatedCost: round(group.cost),
      priced: group.requests > 0 && group.priced,
      local: group.localRequests === group.requests,
      privacyModeRequests: group.privacyModeRequests,
      averageLatencyMs: group.requests ? round(group.latencyTotal / group.requests) : 0
    })).sort((left, right) => right.requests - left.requests || left.model.localeCompare(right.model)));
  }

  function entries() {
    return Object.freeze(buffer.map(item => Object.freeze({ ...item })));
  }

  function reset() {
    buffer.length = 0;
  }

  return Object.freeze({ record, summary, byModel, entries, reset });
}

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPrivacyMode,
  createUsageMeter,
  describeModelCapabilities,
  estimateCost
} from "../apps/fnos-nas-agent/app/model-usage.mjs";

const PRICE_TABLE = {
  "demo-local": { inputPer1k: 0, outputPer1k: 0 },
  "demo-cloud": { inputPer1k: 0.001, outputPer1k: 0.002 }
};

test("estimateCost prices a known model from the price table", () => {
  const result = estimateCost({
    model: "demo-cloud",
    promptTokens: 1000,
    completionTokens: 500,
    priceTable: PRICE_TABLE
  });
  assert.equal(result.priced, true);
  assert.equal(result.currency, "USD");
  assert.equal(result.unit, "per-1k-tokens");
  assert.equal(result.cost, 0.002);
});

test("estimateCost reports priced=false for a model that is not in the price table", () => {
  const result = estimateCost({
    model: "unknown-model",
    promptTokens: 100,
    completionTokens: 100,
    priceTable: PRICE_TABLE
  });
  assert.equal(result.priced, false);
  assert.equal(result.cost, 0);
  assert.equal(result.currency, "USD");
  assert.equal(result.unit, "per-1k-tokens");
});

test("estimateCost matches a model id case insensitively", () => {
  const result = estimateCost({
    model: "Demo-Cloud",
    promptTokens: 1000,
    completionTokens: 1000,
    priceTable: PRICE_TABLE
  });
  assert.equal(result.priced, true);
  assert.equal(result.cost, 0.003);
});

test("estimateCost rejects a price entry that only knows one side", () => {
  const result = estimateCost({
    model: "half-priced",
    promptTokens: 1000,
    completionTokens: 1000,
    priceTable: { "half-priced": { inputPer1k: 0.001 } }
  });
  assert.equal(result.priced, false);
  assert.equal(result.cost, 0);
});

test("estimateCost treats missing input as zero cost and unpriced", () => {
  const result = estimateCost();
  assert.equal(result.priced, false);
  assert.equal(result.cost, 0);
});

test("describeModelCapabilities keeps unknown values null or false", () => {
  const described = describeModelCapabilities({});
  assert.equal(described.id, null);
  assert.equal(described.provider, null);
  assert.equal(described.contextWindow, null);
  assert.equal(described.supportsTools, false);
  assert.equal(described.supportsStreaming, false);
  assert.equal(described.supportsStructuredOutput, false);
  assert.equal(described.privacyLocal, false);
});

test("describeModelCapabilities reports declared capabilities", () => {
  const described = describeModelCapabilities({
    id: "provider-id",
    provider: "local-lab",
    contextWindow: 32768,
    capabilities: { tools: true, streaming: true, structuredOutput: true },
    local: true
  });
  assert.equal(described.id, "provider-id");
  assert.equal(described.provider, "local-lab");
  assert.equal(described.contextWindow, 32768);
  assert.equal(described.supportsTools, true);
  assert.equal(described.supportsStreaming, true);
  assert.equal(described.supportsStructuredOutput, true);
  assert.equal(described.privacyLocal, true);
});

test("describeModelCapabilities does not invent a context window", () => {
  const described = describeModelCapabilities({ contextWindow: 0, capabilities: { tools: "yes" } });
  assert.equal(described.contextWindow, null);
  assert.equal(described.supportsTools, false);
});

test("createUsageMeter records a call and summarizes it", () => {
  const meter = createUsageMeter({ priceTable: PRICE_TABLE });
  meter.record({
    provider: "cloud-lab",
    model: "demo-cloud",
    promptTokens: 1000,
    completionTokens: 500,
    latencyMs: 120,
    outcome: "ok"
  });
  const summary = meter.summary();
  assert.equal(summary.requests, 1);
  assert.equal(summary.ok, 1);
  assert.equal(summary.error, 0);
  assert.deepEqual(summary.byOutcome, { ok: 1, error: 0 });
  assert.equal(summary.promptTokens, 1000);
  assert.equal(summary.completionTokens, 500);
  assert.equal(summary.totalTokens, 1500);
  assert.equal(summary.estimatedCost, 0.002);
  assert.equal(summary.priced, true);
  assert.equal(summary.averageLatencyMs, 120);
});

test("createUsageMeter counts an error outcome separately", () => {
  const meter = createUsageMeter({ priceTable: PRICE_TABLE });
  meter.record({ provider: "cloud-lab", model: "demo-cloud", outcome: "error" });
  const summary = meter.summary();
  assert.equal(summary.requests, 1);
  assert.equal(summary.ok, 0);
  assert.equal(summary.error, 1);
  assert.deepEqual(summary.byOutcome, { ok: 0, error: 1 });
});

test("createUsageMeter drops the oldest entry when the ring buffer is full", () => {
  const meter = createUsageMeter({ maxEntries: 3 });
  for (let index = 1; index <= 5; index += 1) {
    meter.record({ provider: "lab", model: `model-${index}`, outcome: "ok" });
  }
  const entries = meter.entries();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(entry => entry.model), ["model-3", "model-4", "model-5"]);
  assert.equal(meter.summary().requests, 3);
});

test("createUsageMeter keeps the default buffer bound", () => {
  const meter = createUsageMeter();
  for (let index = 0; index < 1200; index += 1) {
    meter.record({ provider: "lab", model: "model", outcome: "ok" });
  }
  assert.equal(meter.entries().length, 1000);
});

test("createUsageMeter rejects an invalid buffer size", () => {
  assert.throws(() => createUsageMeter({ maxEntries: 0 }), TypeError);
  assert.throws(() => createUsageMeter({ maxEntries: 1.5 }), TypeError);
});

test("createUsageMeter ignores a record without a provider", () => {
  const meter = createUsageMeter();
  assert.equal(meter.record({ model: "demo-cloud" }), null);
  assert.equal(meter.entries().length, 0);
});

test("createUsageMeter reports priced=false when a model has no price", () => {
  const meter = createUsageMeter({ priceTable: PRICE_TABLE });
  meter.record({ provider: "lab", model: "demo-cloud", promptTokens: 10, completionTokens: 10, outcome: "ok" });
  meter.record({ provider: "lab", model: "unknown-model", promptTokens: 10, completionTokens: 10, outcome: "ok" });
  const summary = meter.summary();
  assert.equal(summary.priced, false);
  assert.deepEqual(summary.unpricedModels, ["unknown-model"]);
  assert.equal(summary.requests, 2);
});

test("createUsageMeter groups usage per model", () => {
  const meter = createUsageMeter({ priceTable: PRICE_TABLE });
  meter.record({ provider: "cloud-lab", model: "demo-cloud", promptTokens: 1000, completionTokens: 500, outcome: "ok" });
  meter.record({ provider: "cloud-lab", model: "demo-cloud", promptTokens: 2000, completionTokens: 0, outcome: "error" });
  meter.record({ provider: "local-lab", model: "demo-local", promptTokens: 10, completionTokens: 10, outcome: "ok", local: true });
  const groups = meter.byModel();
  assert.equal(groups.length, 2);
  const cloud = groups.find(group => group.model === "demo-cloud");
  assert.equal(cloud.requests, 2);
  assert.equal(cloud.ok, 1);
  assert.equal(cloud.error, 1);
  assert.equal(cloud.promptTokens, 3000);
  assert.equal(cloud.totalTokens, 3500);
  assert.equal(cloud.estimatedCost, 0.004);
  assert.equal(cloud.local, false);
  const local = groups.find(group => group.model === "demo-local");
  assert.equal(local.requests, 1);
  assert.equal(local.local, true);
});

test("createUsageMeter marks a loopback endpoint as local", () => {
  const meter = createUsageMeter();
  meter.record({ provider: "lab", model: "demo-local", endpoint: "http://127.0.0.1:11434/v1/chat/completions", outcome: "ok" });
  meter.record({ provider: "lab", model: "demo-cloud", endpoint: "https://api.example.com/v1/chat/completions", outcome: "ok" });
  const summary = meter.summary();
  assert.equal(summary.localRequests, 1);
  assert.equal(summary.cloudRequests, 1);
});

test("createUsageMeter treats a configured local provider as local", () => {
  const meter = createUsageMeter({ localProviders: ["ollama-local"] });
  meter.record({ provider: "ollama-local", model: "demo-local", outcome: "ok" });
  const summary = meter.summary();
  assert.equal(summary.localRequests, 1);
  assert.equal(summary.cloudRequests, 0);
});

test("createUsageMeter reset clears the buffer", () => {
  const meter = createUsageMeter();
  meter.record({ provider: "lab", model: "demo-cloud", outcome: "ok" });
  meter.reset();
  assert.equal(meter.entries().length, 0);
  assert.equal(meter.summary().requests, 0);
});

test("applyPrivacyMode blocks cloud requests while privacy mode is on", () => {
  const meter = createUsageMeter({ priceTable: PRICE_TABLE });
  meter.record({ provider: "cloud-lab", model: "demo-cloud", promptTokens: 100, completionTokens: 100, outcome: "ok" });
  meter.record({ provider: "local-lab", model: "demo-local", promptTokens: 100, completionTokens: 100, outcome: "ok", local: true });
  const summary = meter.summary();
  assert.equal(summary.localRequests, 1);
  assert.equal(summary.cloudRequests, 1);
  const guarded = applyPrivacyMode(summary, { privacyMode: true });
  assert.equal(guarded.privacyMode, true);
  // The cloud request is not allowed, the local request still is.
  assert.equal(guarded.cloudRequestsAllowed, 1);
  assert.equal(guarded.cloudRequestsBlocked, 1);
  assert.equal(guarded.requests, 2);
});

test("applyPrivacyMode allows every request when privacy mode is off", () => {
  const meter = createUsageMeter();
  meter.record({ provider: "cloud-lab", model: "demo-cloud", outcome: "ok" });
  const summary = meter.summary();
  const guarded = applyPrivacyMode(summary, { privacyMode: false });
  assert.equal(guarded.privacyMode, false);
  assert.equal(guarded.cloudRequestsAllowed, 1);
  assert.equal(guarded.cloudRequestsBlocked, 0);
});

test("applyPrivacyMode allows nothing when every request is a cloud request", () => {
  const guarded = applyPrivacyMode({ requests: 3, localRequests: 0, cloudRequests: 3 }, { privacyMode: true });
  assert.equal(guarded.cloudRequestsAllowed, 0);
  assert.equal(guarded.cloudRequestsBlocked, 3);
});

test("applyPrivacyMode treats an unknown breakdown as cloud traffic", () => {
  const guarded = applyPrivacyMode({ requests: 2 }, { privacyMode: true });
  assert.equal(guarded.cloudRequestsAllowed, 0);
  assert.equal(guarded.cloudRequestsBlocked, 2);
});

test("applyPrivacyMode keeps the summary fields it received", () => {
  const guarded = applyPrivacyMode({ requests: 1, totalTokens: 10, estimatedCost: 0.5 }, { privacyMode: true });
  assert.equal(guarded.totalTokens, 10);
  assert.equal(guarded.estimatedCost, 0.5);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RETRY_DEFAULTS,
  MAX_RETRY_ATTEMPTS,
  classifyFailure,
  computeBackoff,
  decideRetry,
  describeFailure,
  createRetryingInvoker
} from "../apps/fnos-nas-agent/app/retry-policy.mjs";

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "fnos-nas-agent", "app");

function failure(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

test("transient signals are recognised from the message and the code", () => {
  assert.equal(classifyFailure(failure("connect ETIMEDOUT 172.28.10.2:5666")).kind, "transient");
  assert.equal(classifyFailure(failure("read ECONNRESET", { code: "ECONNRESET" })).kind, "transient");
  assert.equal(classifyFailure(failure("socket hang up")).kind, "transient");
  assert.equal(classifyFailure(failure("Too Many Requests")).kind, "transient");
  assert.equal(classifyFailure(failure("Service Unavailable")).kind, "transient");
});

test("transient and permanent HTTP statuses are separated", () => {
  assert.equal(classifyFailure(failure("boom", { statusCode: 503 })).kind, "transient");
  assert.equal(classifyFailure(failure("boom", { status: 429 })).kind, "transient");
  assert.equal(classifyFailure(failure("boom", { statusCode: 500 })).kind, "transient");
  assert.equal(classifyFailure(failure("boom", { statusCode: 403 })).kind, "permanent");
  assert.equal(classifyFailure(failure("boom", { statusCode: 404 })).kind, "permanent");
  assert.equal(classifyFailure(failure("boom", { statusCode: 422 })).kind, "permanent");
});

test("policy denials, cancellations and unknown errors are never retried", () => {
  assert.equal(classifyFailure(failure("policy-denied: destructive tool needs approval")).kind, "permanent");
  assert.equal(classifyFailure(failure("Unauthorized")).kind, "permanent");
  const aborted = failure("The operation was aborted");
  aborted.name = "AbortError";
  assert.equal(classifyFailure(aborted).kind, "permanent");
  assert.equal(classifyFailure(failure("something odd happened")).kind, "unknown");
});

test("the failure description is bounded and never carries the raw error", () => {
  const described = describeFailure(failure("x".repeat(400), { code: "E_TEST", statusCode: 503 }));
  assert.equal(described.message.length, 200);
  assert.equal(described.code, "E_TEST");
  assert.equal(described.status, 503);
  const circular = failure("depth");
  circular.cause = { code: "ECONNREFUSED" };
  assert.equal(describeFailure(circular).code, "ECONNREFUSED");
});

test("backoff grows exponentially and stays under the cap", () => {
  assert.equal(computeBackoff(1), RETRY_DEFAULTS.baseDelayMs);
  assert.equal(computeBackoff(2), RETRY_DEFAULTS.baseDelayMs * 2);
  assert.equal(computeBackoff(5), RETRY_DEFAULTS.maxDelayMs);
  assert.equal(computeBackoff(1, { baseDelayMs: 100, maxDelayMs: 150 }), 100);
  assert.equal(computeBackoff(3, { baseDelayMs: 100, maxDelayMs: 150 }), 150);
});

test("retry is refused once attempts are exhausted, for writes, and for permanent failures", () => {
  const transient = { kind: "transient", reason: "transient-signal" };
  assert.equal(decideRetry({ attempt: 2, maxAttempts: 2, risk: "read-only", failure: transient }).retry, false);
  assert.equal(decideRetry({ attempt: 2, maxAttempts: 2, risk: "read-only", failure: transient }).reason, "attempts-exhausted");
  assert.equal(decideRetry({ attempt: 1, maxAttempts: 2, risk: "write", failure: transient }).retry, false);
  assert.equal(decideRetry({ attempt: 1, maxAttempts: 2, risk: "write", failure: transient }).reason, "not-read-only");
  assert.equal(decideRetry({ attempt: 1, maxAttempts: 2, risk: null, failure: transient }).reason, "not-read-only");
  const permanent = { kind: "permanent", reason: "http-403" };
  assert.equal(decideRetry({ attempt: 1, maxAttempts: 2, risk: "read-only", failure: permanent }).reason, "permanent-failure");
  const unknown = { kind: "unknown", reason: "unknown-error" };
  assert.equal(decideRetry({ attempt: 1, maxAttempts: 2, risk: "read-only", failure: unknown }).reason, "unknown-error");
});

test("the attempt ceiling cannot be raised past MAX_RETRY_ATTEMPTS", () => {
  const decision = decideRetry({ attempt: MAX_RETRY_ATTEMPTS, maxAttempts: 99, risk: "read-only", failure: { kind: "transient" } });
  assert.equal(decision.retry, false);
  const allowed = decideRetry({ attempt: 1, maxAttempts: 99, risk: "read-only", failure: { kind: "transient" } });
  assert.equal(allowed.retry, true);
});

test("a healthy call is invoked once and reports no retry", async () => {
  let calls = 0;
  const invoker = createRetryingInvoker({
    invoke: async () => { calls += 1; return "ok"; },
    resolveRisk: () => "read-only",
    maxAttempts: 2,
    sleep: async () => { throw new Error("must not sleep"); }
  });
  const outcome = await invoker.run({ tool: "storage.summary", args: {} });
  assert.equal(outcome.value, "ok");
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.retried, false);
  assert.equal(calls, 1);
  assert.deepEqual(invoker.retries(), []);
});

test("a transient failure on a read-only tool is retried with backoff", async () => {
  let calls = 0;
  const sleeps = [];
  const seen = [];
  const invoker = createRetryingInvoker({
    invoke: async () => {
      calls += 1;
      if (calls === 1) throw failure("connect ETIMEDOUT");
      return { ok: true };
    },
    resolveRisk: () => "read-only",
    maxAttempts: 2,
    sleep: async (ms) => { sleeps.push(ms); },
    onRetry: (record) => seen.push(record)
  });
  const outcome = await invoker.run({ tool: "network.interfaces", args: {} });
  assert.equal(calls, 2);
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.retried, true);
  assert.deepEqual(sleeps, [RETRY_DEFAULTS.baseDelayMs]);
  assert.deepEqual(seen, [{ tool: "network.interfaces", attempt: 1, nextAttempt: 2, delayMs: RETRY_DEFAULTS.baseDelayMs, reason: "transient-signal" }]);
  assert.deepEqual(invoker.retries(), seen);
});

test("a write tool is never replayed, and a permanent failure is not retried", async () => {
  let writeCalls = 0;
  const writeInvoker = createRetryingInvoker({
    invoke: async () => { writeCalls += 1; throw failure("connect ECONNRESET"); },
    resolveRisk: () => "write",
    maxAttempts: 3,
    sleep: async () => {}
  });
  await assert.rejects(() => writeInvoker.run({ tool: "files.rename" }), /ECONNRESET/);
  assert.equal(writeCalls, 1);

  let readCalls = 0;
  const permanentInvoker = createRetryingInvoker({
    invoke: async () => { readCalls += 1; throw failure("Forbidden", { statusCode: 403 }); },
    resolveRisk: () => "read-only",
    maxAttempts: 3,
    sleep: async () => {}
  });
  await assert.rejects(() => permanentInvoker.run({ tool: "files.list" }), /Forbidden/);
  assert.equal(readCalls, 1);
});

test("an unknown risk from the catalogue means no retry", async () => {
  let calls = 0;
  const invoker = createRetryingInvoker({
    invoke: async () => { calls += 1; throw failure("connect ETIMEDOUT"); },
    resolveRisk: () => null,
    maxAttempts: 2,
    sleep: async () => {}
  });
  await assert.rejects(() => invoker.run({ tool: "unknown.tool" }), /ETIMEDOUT/);
  assert.equal(calls, 1);
});

test("the retry records are copies and the invoker requires an invoke function", async () => {
  assert.throws(() => createRetryingInvoker({}), /invoke/);
  const invoker = createRetryingInvoker({
    invoke: async () => { throw failure("connect ECONNRESET"); },
    resolveRisk: () => "read-only",
    maxAttempts: 2,
    sleep: async () => {}
  });
  await assert.rejects(() => invoker.run({ tool: "storage.summary" }));
  const first = invoker.retries();
  first[0].attempt = 99;
  assert.equal(invoker.retries()[0].attempt, 1);
});

test("the workflow route retries only read-only steps and reports them", async () => {
  const server = await fs.readFile(path.join(appDir, "server.mjs"), "utf8");
  assert.match(server, /import \{ createRetryingInvoker, MAX_RETRY_ATTEMPTS \} from "\.\/retry-policy\.mjs";/);
  assert.match(server, /const retryAttempts = Math\.min\(MAX_RETRY_ATTEMPTS, Math\.max\(1, Math\.trunc\(Number\(input\?\.retryAttempts\) \|\| 1\)\)\);/);
  assert.match(server, /createRetryingInvoker\(\{\s*\n\s*maxAttempts: retryAttempts,\s*\n\s*resolveRisk: \(tool\) => toolRegistry\.get\(tool\)\?\.risk \?\? null,/);
  assert.match(server, /invokeTool: \(request\) => retryInvoker\.run\(request\)/);
  assert.match(server, /return reply\(res, 200, \{ \.\.\.result, retryAttempts, retries: retryInvoker\.retries\(\) \}\);/);
  assert.doesNotMatch(server, /invokeTool: async \(\{ tool, args \}\) => \{ await toolRegistry\.invoke\(tool, args \|\| \{\}\); \}/);
});

test("the operations page offers a dry run for the built-in workflows", async () => {
  const pages = await fs.readFile(path.join(appDir, "ui", "pages.js"), "utf8");
  const html = await fs.readFile(path.join(appDir, "ui", "index.html"), "utf8");
  assert.match(html, /<div id="ops-workflows"><\/div>\s*<div id="ops-workflow-result" class="ops-result"><\/div>/);
  assert.match(pages, /const WORKFLOW_ID_PATTERN=\/\^\[a-z0-9\]\[a-z0-9-\]\{0,63\}\$\/;/);
  assert.match(pages, /button\.dataset\.workflowRun=id;/);
  assert.match(pages, /opsPostJson\("\/api\/workflows",\{workflowId:workflowId,retryAttempts:2\}\)/);
  assert.match(pages, /没有发生重试/);
  assert.equal(/innerHTML\s*=/.test(pages.slice(pages.indexOf("renderOpsWorkflowButtons"), pages.indexOf("async function evalOpsTriggers"))), false, "不得拼 HTML");
});

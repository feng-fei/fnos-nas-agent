import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolTracer, classifyToolError } from "../apps/fnos-nas-agent/app/tool-trace.mjs";
import { createStructuredLogger } from "../apps/fnos-nas-agent/app/structured-logger.mjs";

function collector() {
  const lines = [];
  return {
    lines,
    stream: { write(line) { lines.push(line); return true; } }
  };
}

test("tool trace records a successful call without the arguments or the result", async () => {
  const tracer = createToolTracer({ now: () => 1000, clock: () => "2026-10-22T00:00:00.000Z" });
  const run = tracer.trace({ toolId: "files.list", risk: "read-only", sessionId: "s1", taskId: "t1", requestId: "r1" });
  const result = await run({ path: "/vol1/private", query: "super-secret-credential" }, async args => ({ echo: args.path, count: 3 }));
  assert.deepEqual(result, { echo: "/vol1/private", count: 3 });
  const entries = tracer.list();
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.toolId, "files.list");
  assert.equal(entry.risk, "read-only");
  assert.equal(entry.sessionId, "s1");
  assert.equal(entry.taskId, "t1");
  assert.equal(entry.requestId, "r1");
  assert.equal(entry.startedAt, "2026-10-22T00:00:00.000Z");
  assert.equal(entry.endedAt, "2026-10-22T00:00:00.000Z");
  assert.equal(entry.durationMs, 0);
  assert.equal(entry.outcome, "success");
  assert.equal(entry.resultBytes, Buffer.byteLength(JSON.stringify({ echo: "/vol1/private", count: 3 })));
  assert.equal(entry.errorClass, "");
  assert.match(entry.argsFingerprint, /^[0-9a-f]{16}$/);
  // The raw arguments and the raw result never reach the trace.
  const serialized = JSON.stringify(entries);
  assert.ok(!serialized.includes("super-secret-credential"));
  assert.ok(!serialized.includes("/vol1/private"));
});

test("tool trace classifies failures, denials and timeouts and rethrows the error", async () => {
  const tracer = createToolTracer({ now: () => 0, clock: () => "2026-10-22T00:00:00.000Z" });
  const failure = tracer.trace({ toolId: "files.create-text", risk: "write" });
  await assert.rejects(
    failure({ path: "/vol1/a.txt", content: "top-secret-body" }, async () => {
      throw Object.assign(new Error("Invalid tool arguments"), { statusCode: 400 });
    }),
    /Invalid tool arguments/
  );
  const denial = tracer.trace({ toolId: "files.delete", risk: "destructive" });
  await assert.rejects(
    denial({ path: "/vol1/a.txt" }, async () => {
      throw Object.assign(new Error("capability-missing-xyz"), { statusCode: 403, reason: "missing-capability" });
    }),
    /capability-missing-xyz/
  );
  const timeout = tracer.trace({ toolId: "system.status", risk: "read-only" });
  await assert.rejects(
    timeout({}, async () => { throw Object.assign(new Error("slow"), { code: "ETIMEDOUT" }); }),
    /slow/
  );
  const entries = tracer.list();
  assert.equal(entries.length, 3);
  assert.equal(entries[0].outcome, "error");
  assert.equal(entries[0].errorClass, "validation-error");
  assert.equal(entries[1].outcome, "denied");
  assert.equal(entries[1].errorClass, "policy-denied");
  assert.equal(entries[2].outcome, "timeout");
  assert.equal(entries[2].errorClass, "timeout");
  assert.equal(entries[0].resultBytes, 0);
  const serialized = JSON.stringify(entries);
  assert.ok(!serialized.includes("top-secret-body"));
  assert.ok(!serialized.includes("Invalid tool arguments"));
  assert.ok(!serialized.includes("capability-missing-xyz"));
});

test("tool trace keeps the duration and the result size of a call", async () => {
  let tick = 0;
  const tracer = createToolTracer({ now: () => (tick += 25), clock: () => `t-${tick}` });
  const run = tracer.trace({ toolId: "files.preview", risk: "read-only" });
  await run({}, async () => "0123456789");
  const [entry] = tracer.list();
  assert.equal(entry.durationMs, 25);
  assert.equal(entry.resultBytes, 10);
  assert.notEqual(entry.startedAt, entry.endedAt);
});

test("tool trace keeps only the newest entries in the ring buffer", async () => {
  const tracer = createToolTracer({ maxEntries: 3, now: () => 0, clock: () => "2026-10-22T00:00:00.000Z" });
  for (let i = 0; i < 6; i++) {
    const run = tracer.trace({ toolId: `tool-${i}`, risk: "read-only" });
    await run({ i }, async () => i);
  }
  const entries = tracer.list();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(entry => entry.toolId), ["tool-3", "tool-4", "tool-5"]);
  tracer.clear();
  assert.equal(tracer.list().length, 0);
  assert.equal(tracer.summary().total, 0);
});

test("tool trace summary counts the calls per tool and per outcome", async () => {
  const tracer = createToolTracer({ now: () => 5, clock: () => "2026-10-22T00:00:00.000Z" });
  const ok = tracer.trace({ toolId: "files.list", risk: "read-only" });
  const bad = tracer.trace({ toolId: "files.list", risk: "read-only" });
  const other = tracer.trace({ toolId: "system.status", risk: "read-only" });
  await ok({}, async () => "a");
  await assert.rejects(bad({}, async () => { throw Object.assign(new Error("nope"), { statusCode: 404 }); }), /nope/);
  await other({}, async () => "b");
  const summary = tracer.summary();
  assert.equal(summary.total, 3);
  assert.equal(summary.byTool["files.list"].count, 2);
  assert.equal(summary.byTool["files.list"].outcomes.success, 1);
  assert.equal(summary.byTool["files.list"].outcomes.error, 1);
  assert.equal(summary.byTool["system.status"].count, 1);
  assert.equal(summary.byOutcome.success, 2);
  assert.equal(summary.byOutcome.error, 1);
  assert.equal(summary.totalDurationMs, 0);
});

test("tool trace writes a JSONL file with mode 0600 and never the arguments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-trace-"));
  const tracer = createToolTracer({ dataDir: dir, now: () => 0, clock: () => "2026-10-22T00:00:00.000Z" });
  const run = tracer.trace({ toolId: "files.list", risk: "read-only", sessionId: "s1" });
  await run({ path: "/vol1/hidden-dir" }, async () => ({ ok: true }));
  await tracer.flush();
  const lines = (await readFile(tracer.filePath(), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.toolId, "files.list");
  assert.equal(entry.outcome, "success");
  assert.ok(!lines[0].includes("/vol1/hidden-dir"));
  // The POSIX mode bits are only enforced on a file system that supports them
  // (the NAS runtime). On Windows they read back as 0666.
  if (process.platform !== "win32") assert.equal((await stat(tracer.filePath())).mode & 0o777, 0o600);
});

test("tool trace rotates the JSONL file with a single generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-trace-"));
  const tracer = createToolTracer({ dataDir: dir, maxBytes: 1024, now: () => 0, clock: () => "2026-10-22T00:00:00.000Z" });
  for (let i = 0; i < 12; i++) {
    const run = tracer.trace({ toolId: `tool-${i}`, risk: "read-only" });
    await run({ i }, async () => i);
  }
  await tracer.flush();
  const files = await readdir(dir);
  assert.ok(files.includes("tool-trace.jsonl"));
  assert.ok(files.includes("tool-trace.jsonl.1"));
  assert.ok(!files.includes("tool-trace.jsonl.2"));
  assert.ok((await stat(join(dir, "tool-trace.jsonl"))).size <= 1024);
  assert.ok((await stat(join(dir, "tool-trace.jsonl.1"))).size <= 1024);
});

test("tool trace refuses an invalid configuration", () => {
  assert.throws(() => createToolTracer({ maxEntries: 0 }), TypeError);
  assert.throws(() => createToolTracer({ maxBytes: 10 }), TypeError);
  assert.throws(() => createToolTracer({ now: "not-a-function" }), TypeError);
  assert.throws(() => createToolTracer({ writeFile: 42 }), TypeError);
});

test("tool error classification uses a fixed vocabulary", () => {
  assert.deepEqual(classifyToolError(Object.assign(new Error("x"), { statusCode: 400 })), { outcome: "error", errorClass: "validation-error" });
  assert.deepEqual(classifyToolError(Object.assign(new Error("x"), { statusCode: 403 })), { outcome: "denied", errorClass: "policy-denied" });
  assert.deepEqual(classifyToolError(Object.assign(new Error("x"), { statusCode: 404 })), { outcome: "error", errorClass: "not-found" });
  assert.deepEqual(classifyToolError(Object.assign(new Error("x"), { statusCode: 503 })), { outcome: "error", errorClass: "upstream-error" });
  assert.deepEqual(classifyToolError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })), { outcome: "timeout", errorClass: "timeout" });
  assert.deepEqual(classifyToolError(new Error("x")), { outcome: "error", errorClass: "unknown" });
});

test("structured logger writes one JSON line per event and drops the sensitive field names", () => {
  const { lines, stream } = collector();
  const logger = createStructuredLogger({ stream, level: "info", now: () => "2026-10-22T00:00:00.000Z" });
  logger.info("tool.started", { toolId: "files.list", durationMs: 12, ok: true, empty: null });
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.deepEqual(record, { ts: "2026-10-22T00:00:00.000Z", level: "info", event: "tool.started", toolId: "files.list", durationMs: 12, ok: true, empty: null });
});

test("structured logger drops every field that looks like a secret carrier", () => {
  const { lines, stream } = collector();
  const logger = createStructuredLogger({ stream, now: () => "2026-10-22T00:00:00.000Z" });
  logger.error("model.failed", {
    apiKey: "sk-live-1234567890",
    access_token: "tok-abcdef",
    password: "hunter2",
    Authorization: "Bearer abc",
    cookie: "sid=1",
    clientSecret: "s3cr3t",
    model: "deepseek-chat",
    statusCode: 500
  });
  const record = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(record).sort(), ["event", "level", "model", "statusCode", "ts"]);
  assert.ok(!lines[0].includes("sk-live-1234567890"));
  assert.ok(!lines[0].includes("hunter2"));
  assert.ok(!lines[0].includes("Bearer abc"));
});

test("structured logger keeps only scalar values and truncates a long one", () => {
  const { lines, stream } = collector();
  const logger = createStructuredLogger({ stream, now: () => "2026-10-22T00:00:00.000Z" });
  logger.info("tool.finished", { nested: { a: 1 }, list: [1, 2], text: "x".repeat(400) });
  const record = JSON.parse(lines[0]);
  assert.equal(record.nested, undefined);
  assert.equal(record.list, undefined);
  assert.equal(record.text.length, 256);
});

test("structured logger filters by level", () => {
  const { lines, stream } = collector();
  const logger = createStructuredLogger({ stream, level: "warn", now: () => "2026-10-22T00:00:00.000Z" });
  logger.debug("noisy", { a: 1 });
  logger.info("chatty", { a: 1 });
  logger.warn("careful", { a: 1 });
  logger.error("broken", { a: 1 });
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).level, "warn");
  assert.equal(JSON.parse(lines[1]).level, "error");
});

test("structured logger child adds the context and the event name", () => {
  const { lines, stream } = collector();
  const logger = createStructuredLogger({ stream, now: () => "2026-10-22T00:00:00.000Z" });
  const child = logger.child({ event: "tool.run", toolId: "files.list" });
  child.info(undefined, { durationMs: 3 });
  const record = JSON.parse(lines[0]);
  assert.equal(record.event, "tool.run");
  assert.equal(record.toolId, "files.list");
  assert.equal(record.durationMs, 3);
});

test("structured logger honours an explicit field allowlist", () => {
  const { lines, stream } = collector();
  const logger = createStructuredLogger({ stream, now: () => "2026-10-22T00:00:00.000Z", allowedFields: ["toolId"] });
  logger.info("tool.started", { toolId: "files.list", other: "dropped" });
  const record = JSON.parse(lines[0]);
  assert.equal(record.toolId, "files.list");
  assert.equal(record.other, undefined);
});

test("structured logger refuses an unusable stream", () => {
  assert.throws(() => createStructuredLogger({ stream: null }), TypeError);
  assert.throws(() => createStructuredLogger({ now: "nope" }), TypeError);
});

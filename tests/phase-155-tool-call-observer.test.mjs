import test from "node:test";
import assert from "node:assert/strict";
import { createToolCallObserver, classifyObserverError, OBSERVER_STATUSES, OBSERVER_ERROR_CODES } from "../apps/fnos-nas-agent/app/tool-call-observer.mjs";

// A logger that keeps every line it receives, so a test can look at what an
// operator would see.
function recordingLogger() {
  const lines = [];
  return {
    lines,
    log(level, event, fields) { lines.push({ level, event, fields: { ...fields } }); }
  };
}

test("a successful call is recorded with the status ok and no error code", async () => {
  const observer = createToolCallObserver();
  const result = await observer.observe({ toolId: "files.list", source: "builtin", risk: "read-only" }, async () => ({ entries: [] }));
  assert.deepEqual(result, { entries: [] });
  const records = observer.listRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].toolId, "files.list");
  assert.equal(records[0].source, "builtin");
  assert.equal(records[0].risk, "read-only");
  assert.equal(records[0].status, "ok");
  assert.equal(records[0].errorCode, "");
  assert.equal(typeof records[0].durationMs, "number");
  assert.ok(records[0].startedAt);
  assert.ok(records[0].endedAt);
});

test("a thrown error is recorded and rethrown to the caller", async () => {
  const observer = createToolCallObserver();
  await assert.rejects(
    () => observer.observe({ toolId: "files.upload", risk: "write" }, async () => { throw new Error("boom"); }),
    /boom/
  );
  const records = observer.listRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "error");
  assert.equal(records[0].errorCode, "tool_error");
  assert.equal(records[0].toolId, "files.upload");
});

test("an approval rejection is recorded as denied", async () => {
  const observer = createToolCallObserver();
  await assert.rejects(
    () => observer.observe({ toolId: "files.delete", risk: "destructive" }, async () => {
      throw Object.assign(new Error("破坏性工具调用缺少服务端授权凭据"), { statusCode: 403, reason: "approval-required" });
    })
  );
  const record = observer.listRecords()[0];
  assert.equal(record.status, "denied");
  assert.equal(record.errorCode, "tool_denied");
});

test("invalid arguments are recorded as invalid_args", async () => {
  const observer = createToolCallObserver();
  await assert.rejects(
    () => observer.observe({ toolId: "files.preview" }, async () => {
      throw Object.assign(new Error("Invalid tool arguments"), { statusCode: 400 });
    })
  );
  const record = observer.listRecords()[0];
  assert.equal(record.status, "error");
  assert.equal(record.errorCode, "invalid_args");
});

test("a timeout error is recorded with the status timeout", async () => {
  const observer = createToolCallObserver();
  await assert.rejects(
    () => observer.observe({ toolId: "trim.volume.list" }, async () => {
      throw Object.assign(new Error("upstream timeout"), { code: "ETIMEDOUT" });
    })
  );
  const record = observer.listRecords()[0];
  assert.equal(record.status, "timeout");
  assert.equal(record.errorCode, "timeout");
});

test("a call that exceeds its deadline ends as a timeout", async () => {
  const observer = createToolCallObserver();
  await assert.rejects(
    () => observer.observe({ toolId: "slow.tool", timeoutMs: 20 }, () => new Promise(() => {})),
    /timed out/
  );
  const record = observer.listRecords()[0];
  assert.equal(record.status, "timeout");
  assert.equal(record.errorCode, "timeout");
});

test("a returned failure object is recorded as a terminal state", async () => {
  const observer = createToolCallObserver();
  const result = await observer.observe({ toolId: "files.list" }, async () => ({ ok: false, error: { code: "invalid_args", message: "secret detail" } }));
  assert.equal(result.ok, false);
  const record = observer.listRecords()[0];
  assert.equal(record.status, "error");
  assert.equal(record.errorCode, "invalid_args");
  assert.equal(JSON.stringify(record).includes("secret detail"), false);
});

test("a model failure and a cancellation keep their own error codes", async () => {
  const observer = createToolCallObserver();
  await assert.rejects(() => observer.observe({ toolId: "a" }, async () => { throw Object.assign(new Error("x"), { code: "MODEL_FAILURE" }); }));
  await assert.rejects(() => observer.observe({ toolId: "b" }, async () => { throw Object.assign(new Error("x"), { code: "TASK_CANCELLED" }); }));
  const records = observer.listRecords();
  assert.equal(records[0].errorCode, "model_failure");
  assert.equal(records[0].status, "error");
  assert.equal(records[1].errorCode, "cancelled");
});

test("the duration is the time between the start and the end of the call", async () => {
  let current = 1_000;
  const observer = createToolCallObserver({ now: () => current });
  await observer.observe({ toolId: "files.list" }, async () => { current = 1_250; return true; });
  const record = observer.listRecords()[0];
  assert.equal(record.durationMs, 250);
});

test("only the most recent records are kept when the memory limit is reached", async () => {
  const observer = createToolCallObserver({ maxRecords: 3 });
  for (let index = 0; index < 5; index += 1) {
    await observer.observe({ toolId: `tool.${index}` }, async () => true);
  }
  const records = observer.listRecords();
  assert.equal(records.length, 3);
  assert.deepEqual(records.map(record => record.toolId), ["tool.2", "tool.3", "tool.4"]);
  assert.equal(observer.count(), 3);
});

test("no argument value and no credential ever reaches a record", async () => {
  const observer = createToolCallObserver();
  const apiKey = "sk-live-abcdef0123456789abcdef";
  const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
  await observer.observe({ toolId: "files.write", args: { path: "/data/report.txt", apiKey, token } }, async () => ({ ok: true }));
  const record = observer.listRecords()[0];
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes(apiKey), false);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes("/data/report.txt"), false);
  assert.equal(record.argsFingerprint.length, 16);
  assert.equal(record.argsBytes > 0, true);
});

test("a value that looks like a credential is redacted", async () => {
  const observer = createToolCallObserver();
  const secret = "sk-live-abcdef0123456789abcdef";
  await observer.observe({ toolId: secret, source: "builtin" }, async () => true);
  const record = observer.listRecords()[0];
  assert.equal(record.toolId, "[redacted]");
  assert.equal(JSON.stringify(record).includes(secret), false);
});

test("listRecords returns the records in order and honours the limit", async () => {
  const observer = createToolCallObserver();
  for (let index = 0; index < 5; index += 1) {
    await observer.observe({ toolId: `tool.${index}` }, async () => true);
  }
  const all = observer.listRecords();
  assert.deepEqual(all.map(record => record.id), [1, 2, 3, 4, 5]);
  const last = observer.listRecords(2);
  assert.deepEqual(last.map(record => record.id), [4, 5]);
  assert.deepEqual(observer.listRecords(0), []);
});

test("clear removes every record from the memory", async () => {
  const observer = createToolCallObserver();
  await observer.observe({ toolId: "files.list" }, async () => true);
  assert.equal(observer.listRecords().length, 1);
  observer.clear();
  assert.deepEqual(observer.listRecords(), []);
  assert.equal(observer.count(), 0);
  assert.equal(observer.summary().total, 0);
});

test("every observed call ends with exactly one terminal record", async () => {
  const observer = createToolCallObserver();
  await observer.observe({ toolId: "ok" }, async () => true);
  await assert.rejects(() => observer.observe({ toolId: "throw" }, async () => { throw new Error("x"); }));
  await observer.observe({ toolId: "failed" }, async () => ({ ok: false, error: { code: "tool_error" } }));
  await assert.rejects(() => observer.observe({ toolId: "denied" }, async () => { throw Object.assign(new Error("x"), { statusCode: 403 }); }));
  const records = observer.listRecords();
  assert.equal(records.length, 4);
  assert.deepEqual(records.map(record => record.status), ["ok", "error", "error", "denied"]);
  for (const record of records) {
    assert.ok(OBSERVER_STATUSES.includes(record.status));
    assert.ok(record.errorCode === "" || OBSERVER_ERROR_CODES.includes(record.errorCode));
    assert.ok(record.endedAt);
    assert.equal(typeof record.durationMs, "number");
  }
  const ids = records.map(record => record.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("the observed function is called exactly once and keeps its result", async () => {
  const observer = createToolCallObserver();
  let calls = 0;
  const result = await observer.observe({ toolId: "files.list" }, async () => { calls += 1; return { entries: [1] }; });
  assert.equal(calls, 1);
  assert.deepEqual(result, { entries: [1] });
});

test("the trace of Phase 146 receives the call and the record", async () => {
  const traced = [];
  const records = [];
  const trace = {
    trace(context) {
      traced.push(context);
      return { run: async (args, invokeFn) => invokeFn(args) };
    },
    record(entry) { records.push(entry); }
  };
  const observer = createToolCallObserver({ trace });
  await observer.observe({ toolId: "files.list", source: "builtin", risk: "read-only", sessionId: "s1", taskId: "t1" }, async () => true);
  assert.equal(traced.length, 1);
  assert.equal(traced[0].toolId, "files.list");
  assert.equal(traced[0].risk, "read-only");
  assert.equal(traced[0].sessionId, "s1");
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "ok");
  assert.equal(records[0].source, "builtin");
});

test("the logger receives one line per call and no secret", async () => {
  const logger = recordingLogger();
  const observer = createToolCallObserver({ logger });
  const apiKey = "sk-live-abcdef0123456789abcdef";
  await observer.observe({ toolId: "files.write", args: { apiKey } }, async () => true);
  assert.equal(logger.lines.length, 1);
  assert.equal(logger.lines[0].event, "tool.call");
  assert.equal(logger.lines[0].level, "info");
  assert.equal(logger.lines[0].fields.status, "ok");
  assert.equal(JSON.stringify(logger.lines).includes(apiKey), false);
  assert.equal("args" in logger.lines[0].fields, false);
});

test("the summary counts the recorded calls", async () => {
  const observer = createToolCallObserver();
  await observer.observe({ toolId: "a", source: "builtin" }, async () => true);
  await assert.rejects(() => observer.observe({ toolId: "b", source: "mcp" }, async () => { throw Object.assign(new Error("x"), { statusCode: 403 }); }));
  const summary = observer.summary();
  assert.equal(summary.total, 2);
  assert.equal(summary.byStatus.ok, 1);
  assert.equal(summary.byStatus.denied, 1);
  assert.equal(summary.bySource.builtin, 1);
  assert.equal(summary.bySource.mcp, 1);
  assert.equal(summary.byTool.a.count, 1);
});

test("the classifier maps the known error shapes onto the observer vocabulary", () => {
  assert.deepEqual(classifyObserverError(Object.assign(new Error("x"), { statusCode: 400 })), { status: "error", errorCode: "invalid_args" });
  assert.deepEqual(classifyObserverError(Object.assign(new Error("x"), { statusCode: 403 })), { status: "denied", errorCode: "tool_denied" });
  assert.deepEqual(classifyObserverError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })), { status: "timeout", errorCode: "timeout" });
  assert.deepEqual(classifyObserverError(Object.assign(new Error("x"), { code: "MODEL_FAILURE" })), { status: "error", errorCode: "model_failure" });
  assert.deepEqual(classifyObserverError(new Error("x")), { status: "error", errorCode: "tool_error" });
  assert.deepEqual(classifyObserverError(null), { status: "error", errorCode: "unknown" });
});

test("an invalid observer configuration is refused", () => {
  assert.throws(() => createToolCallObserver({ clock: "noon" }), TypeError);
  assert.throws(() => createToolCallObserver({ maxRecords: 0 }), TypeError);
  assert.throws(() => createToolCallObserver({ maxRecords: 1.5 }), TypeError);
  assert.throws(() => createToolCallObserver({ trace: "trace" }), TypeError);
  assert.throws(() => createToolCallObserver({ logger: "logger" }), TypeError);
});

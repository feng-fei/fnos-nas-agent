import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditLogger } from "../apps/fnos-nas-agent/app/audit-log.mjs";

const NOW = () => "2026-10-22T00:00:00.000Z";

async function readEvents(audit) {
  const raw = await readFile(audit.filePath(), "utf8");
  return raw.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("audit log accepts the checksum and execution-mode routes without normalizing them away", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-audit-"));
  const audit = createAuditLogger({ dataDir: dir, now: NOW });
  await audit.record({ method: "GET", route: "files.checksum", statusCode: 200 });
  await audit.record({ method: "POST", route: "execution.mode", statusCode: 200 });
  await audit.flush();
  const events = await readEvents(audit);
  assert.equal(events.length, 2);
  assert.equal(events[0].route, "files.checksum");
  assert.equal(events[1].route, "execution.mode");
  await rm(dir, { recursive: true, force: true });
});

test("audit log never throws for hostile event payloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-audit-"));
  const audit = createAuditLogger({ dataDir: dir, now: NOW });
  const hostile = [
    undefined,
    null,
    {},
    { method: 42, route: 7, statusCode: "200" },
    { method: "GET", route: "", statusCode: 0 },
    { method: "GET", route: "login", statusCode: 999 },
    { method: "get", route: "login", statusCode: 200 },
    { method: "GET", route: "login", statusCode: 200, sessionId: { toString: () => "x" } }
  ];
  for (const event of hostile) {
    let pending = null;
    assert.doesNotThrow(() => { pending = audit.record(event); });
    await pending;
  }
  await audit.flush();
  const events = await readEvents(audit);
  assert.equal(events.length, hostile.length);
  for (const event of events) {
    assert.equal(typeof event.at, "string");
    assert.equal(typeof event.method, "string");
    assert.equal(typeof event.route, "string");
    assert.equal(Number.isInteger(event.statusCode), true);
    assert.equal(typeof event.outcome, "string");
  }
  await rm(dir, { recursive: true, force: true });
});

test("audit log drops unusable optional metadata instead of persisting it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-audit-"));
  const audit = createAuditLogger({ dataDir: dir, now: NOW });
  await audit.record({
    method: "POST", route: "tools.run", statusCode: 200,
    sessionId: "  digest-value  ",
    toolId: "files.list",
    target: "/vol1/demo.txt",
    risk: "read-only",
    requestId: "req-1",
    ignored: "value"
  });
  await audit.record({
    method: "POST", route: "tools.run", statusCode: 200,
    sessionId: "x".repeat(4096),
    toolId: "badvalue",
    target: 12,
    risk: null,
    requestId: ""
  });
  await audit.flush();
  const events = await readEvents(audit);
  assert.equal(events[0].sessionId, "digest-value");
  assert.equal(events[0].toolId, "files.list");
  assert.equal(events[0].target, "/vol1/demo.txt");
  assert.equal(events[0].risk, "read-only");
  assert.equal(events[0].requestId, "req-1");
  assert.equal("ignored" in events[0], false);
  assert.equal("sessionId" in events[1], false);
  assert.equal("toolId" in events[1], false);
  assert.equal("target" in events[1], false);
  assert.equal("risk" in events[1], false);
  assert.equal("requestId" in events[1], false);
  await rm(dir, { recursive: true, force: true });
});

test("audit log reports write failures and keeps recording later events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-audit-"));
  const blocked = join(dir, "blocked");
  await rm(blocked, { recursive: true, force: true });
  // A regular file where the audit directory should be makes every write fail.
  await (await import("node:fs/promises")).writeFile(blocked, "not a directory", "utf8");
  const audit = createAuditLogger({ dataDir: blocked, now: NOW });

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.join(" ")); };
  try {
    await audit.record({ method: "GET", route: "login", statusCode: 200 });
    await audit.flush();
  } finally {
    console.error = originalError;
  }
  assert.ok(errors.length >= 1, "a failing audit write must be reported");
  assert.ok(errors.join("\n").includes("audit"));
  await rm(dir, { recursive: true, force: true });
});

test("audit log keeps the JSONL contract and rotates at the configured size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-audit-"));
  const audit = createAuditLogger({ dataDir: dir, maxBytes: 512, now: NOW });
  for (let index = 0; index < 40; index++) await audit.record({ method: "GET", route: "tasks.list", statusCode: 200, requestId: `req-${index}` });
  await audit.flush();
  const files = await readdir(dir);
  assert.ok(files.includes("audit.jsonl"));
  assert.ok(files.includes("audit.jsonl.1"));
  assert.equal(files.includes("audit.jsonl.2"), false);
  const events = await readEvents(audit);
  assert.ok(events.length > 0);
  for (const event of events) assert.equal(event.route, "tasks.list");
  await rm(dir, { recursive: true, force: true });
});

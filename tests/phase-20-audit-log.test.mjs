import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditLogger } from "../apps/fnos-nas-agent/app/audit-log.mjs";

test("audit log stores only allowlisted metadata and never caller secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-audit-"));
  const audit = createAuditLogger({ dataDir: dir, now: () => "2026-10-21T00:00:00.000Z" });
  await audit.record({ method: "POST", route: "login", statusCode: 401, password: "secret", token: "private", ip: "192.0.2.1" });
  const lines = (await readFile(audit.filePath(), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    at: "2026-10-21T00:00:00.000Z", method: "POST", route: "login", statusCode: 401, outcome: "rejected"
  });
  assert.ok(!lines[0].includes("secret"));
  assert.ok(!lines[0].includes("private"));
  assert.ok(!lines[0].includes("192.0.2.1"));
  assert.equal((await stat(audit.filePath())).mode & 0o777, 0o600);
});

test("audit log bounds storage with a single rotated generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-audit-"));
  const audit = createAuditLogger({ dataDir: dir, maxBytes: 256, now: () => "2026-10-21T00:00:00.000Z" });
  for (let i = 0; i < 8; i++) await audit.record({ method: "GET", route: "tasks.list", statusCode: 200 });
  await audit.flush();
  const files = await readdir(dir);
  assert.ok(files.includes("audit.jsonl"));
  assert.ok(files.includes("audit.jsonl.1"));
  assert.ok((await stat(join(dir, "audit.jsonl"))).size <= 256);
  assert.ok((await stat(join(dir, "audit.jsonl.1"))).size <= 256);
  assert.ok(!files.includes("audit.jsonl.2"));
});

test("audit log refuses unsafe filenames and normalizes unknown metadata instead of throwing", async () => {
  assert.throws(() => createAuditLogger({ dataDir: "/tmp/audit", filename: "../secret" }), TypeError);
  const dir = await mkdtemp(join(tmpdir(), "fnos-audit-"));
  const audit = createAuditLogger({ dataDir: dir, now: () => "2026-10-21T00:00:00.000Z" });
  // record() runs from a response "finish" listener, outside the request try/catch.
  // An unknown route, an unsupported method or a malformed status code must be
  // normalized instead of taking the process down.
  await audit.record({ method: "GET", route: "/api/login?token=secret", statusCode: 200 });
  await audit.record({ method: "TRACE", route: "login", statusCode: 200 });
  await audit.record({ method: "GET", route: "login", statusCode: "nope" });
  await audit.flush();
  const lines = (await readFile(audit.filePath(), "utf8")).trim().split("\n");
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[0]), {
    at: "2026-10-21T00:00:00.000Z", method: "GET", route: "other_api", statusCode: 200, outcome: "success"
  });
  assert.deepEqual(JSON.parse(lines[1]), {
    at: "2026-10-21T00:00:00.000Z", method: "UNKNOWN", route: "login", statusCode: 200, outcome: "success"
  });
  assert.deepEqual(JSON.parse(lines[2]), {
    at: "2026-10-21T00:00:00.000Z", method: "GET", route: "login", statusCode: 500, outcome: "error"
  });
  assert.ok(!lines.join("").includes("secret"));
});

test("audit log records the session digest and the tool metadata of an event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fnos-audit-"));
  const audit = createAuditLogger({ dataDir: dir, now: () => "2026-10-21T00:00:00.000Z" });
  await audit.record({
    method: "POST", route: "tools.run", statusCode: 403,
    sessionId: "a58afd99b43c5ccc1836ce21cd20abd0fee4363281983db5bc9a9fc245bf1a45",
    toolId: "files.delete", target: "/vol1/demo.txt", risk: "destructive"
  });
  await audit.flush();
  const line = JSON.parse((await readFile(audit.filePath(), "utf8")).trim());
  assert.equal(line.sessionId, "a58afd99b43c5ccc1836ce21cd20abd0fee4363281983db5bc9a9fc245bf1a45");
  assert.equal(line.toolId, "files.delete");
  assert.equal(line.target, "/vol1/demo.txt");
  assert.equal(line.risk, "destructive");
  assert.equal(line.outcome, "rejected");
});

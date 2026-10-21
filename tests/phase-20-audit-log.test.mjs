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

test("audit log rejects unknown route and unsafe filenames", () => {
  assert.throws(() => createAuditLogger({ dataDir: "/tmp/audit", filename: "../secret" }), TypeError);
  const audit = createAuditLogger({ dataDir: "/tmp/audit" });
  assert.throws(() => audit.record({ method: "GET", route: "/api/login?token=secret", statusCode: 200 }), TypeError);
  assert.throws(() => audit.record({ method: "TRACE", route: "login", statusCode: 200 }), TypeError);
});

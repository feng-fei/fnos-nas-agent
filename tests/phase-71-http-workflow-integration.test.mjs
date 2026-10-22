import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import { makeZip, quarantineArchive, READ_ONLY_MANIFEST } from "./helpers/skill-archive.mjs";

async function unusedPort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test("authenticated task, Skill batch review, cleanup and audit filters work through HTTP", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-workflow-http-"));
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const serverPath = join(process.cwd(), "apps/fnos-nas-agent/app/server.mjs");
  const child = spawn(process.execPath, [serverPath], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });
  const headers = { origin, "content-type": "application/json" };
  let cookie = "";
  const request = (path, options = {}) => fetch(origin + path, {
    ...options,
    headers: { ...headers, ...(cookie ? { cookie } : {}), ...(options.headers || {}) }
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise(resolve => child.once("exit", resolve)),
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  let healthy = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(origin + "/api/health");
      if (response.ok) { healthy = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true, `server did not become healthy. Output: ${output}`);

  const setup = await request("/api/setup", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(setup.status, 201, await setup.text());
  const login = await request("/api/session", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(login.status, 200, await login.text());
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^nas_agent_session=/);

  const taskInvalid = await request("/api/tasks?status=unknown");
  assert.equal(taskInvalid.status, 400);
  const taskPage = await request("/api/tasks?status=queued&limit=10&offset=0");
  assert.equal(taskPage.status, 200);
  assert.equal(taskPage.headers.get("x-content-type-options"), "nosniff");
  const taskPayload = await taskPage.json();
  assert.ok(Number.isInteger(taskPayload.total));
  assert.equal(taskPayload.status, "queued");
  assert.equal(taskPayload.limit, 10);
  assert.equal(taskPayload.offset, 0);
  assert.ok(Array.isArray(taskPayload.tasks));

  // Phase 136: the server derives the review from the quarantined bytes, so a
  // real archive has to be in the quarantine directory before the registration.
  const makeSkill = async (name, manifestName) => {
    const digest = await quarantineArchive(dataDir, makeZip([{
      name: "SKILL.md",
      data: `---\nname: ${manifestName}\ndescription: A minimal read-only Skill used by the integration tests\n---\nOnly reads files.\n`
    }]));
    const response = await request("/api/skills", {
      method: "POST",
      body: JSON.stringify({ name, version: "1.0.0", sourceLabel: "integration-test", archiveSha256: digest, declaredCapabilities: [] })
    });
    assert.equal(response.status, 201);
    return (await response.json()).skill;
  };
  const reviewable = await makeSkill("Integration A", "integration-a");
  const invalidTransition = await makeSkill("Integration B", "integration-b");
  const batch = await request("/api/skills/transitions/batch", {
    method: "POST",
    body: JSON.stringify({ items: [
      { id: reviewable.id, state: "approved", note: "integration review" },
      { id: invalidTransition.id, state: "enabled", note: "should fail lifecycle policy" }
    ] })
  });
  assert.equal(batch.status, 200);
  const batchPayload = await batch.json();
  assert.equal(batchPayload.total, 2);
  assert.equal(batchPayload.succeeded, 1);
  assert.equal(batchPayload.failed, 1);
  assert.equal(batchPayload.results.find(item => item.id === reviewable.id).state, "approved");
  assert.equal(batchPayload.results.find(item => item.id === invalidTransition.id).ok, false);

  const duplicate = await request("/api/skills/transitions/batch", {
    method: "POST",
    body: JSON.stringify({ items: [{ id: reviewable.id, state: "enabled" }, { id: reviewable.id, state: "disabled" }] })
  });
  assert.equal(duplicate.status, 400);

  const wrongOrigin = await request("/api/tasks/clear-history", {
    method: "POST",
    headers: { origin: "http://attacker.invalid" }
  });
  assert.equal(wrongOrigin.status, 403);
  const clear = await request("/api/tasks/clear-history", { method: "POST" });
  assert.equal(clear.status, 200);
  assert.equal((await clear.json()).removed, 0);

  const invalidAuditFilter = await request("/api/audit?outcome=unknown");
  assert.equal(invalidAuditFilter.status, 400);
  const audit = await request("/api/audit?limit=10&offset=0&outcome=success");
  assert.equal(audit.status, 200);
  const auditPayload = await audit.json();
  assert.equal(auditPayload.limit, 10);
  assert.equal(auditPayload.offset, 0);
  assert.ok(Number.isInteger(auditPayload.total));
  assert.ok(Array.isArray(auditPayload.events));
  assert.ok(auditPayload.events.every(event => !("password" in event) && !("token" in event) && !("input" in event)));
});

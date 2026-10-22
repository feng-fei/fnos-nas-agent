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

test("single Skill lifecycle transitions enforce review before enablement and persist state", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-skill-lifecycle-"));
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
    ...options, headers: { ...headers, ...(cookie ? { cookie } : {}), ...(options.headers || {}) }
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
    try { const response = await fetch(origin + "/api/health"); if (response.ok) { healthy = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true, `server did not become healthy. Output: ${output}`);
  const setup = await request("/api/setup", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(setup.status, 201);
  const login = await request("/api/session", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(login.status, 200);
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  // Phase 136: the server reviews the quarantined bytes itself, so the
  // archive has to exist in the quarantine directory before the registration.
  const digest = await quarantineArchive(dataDir, makeZip([{ name: "SKILL.md", data: READ_ONLY_MANIFEST }]));
  const registered = await request("/api/skills", {
    method: "POST",
    body: JSON.stringify({ name: "Lifecycle Integration", version: "1.0.0", sourceLabel: "test", archiveSha256: digest, declaredCapabilities: [] })
  });
  assert.equal(registered.status, 201);
  const skill = (await registered.json()).skill;
  assert.equal(skill.state, "pending_review");
  assert.equal(skill.manifestReview.reviewedBy, "server");

  const blockedEnable = await request(`/api/skills/${skill.id}/transition`, {
    method: "POST", body: JSON.stringify({ state: "enabled", note: "must review first" })
  });
  assert.equal(blockedEnable.status, 409);
  const blockedPayload = await blockedEnable.json();
  assert.match(blockedPayload.error, /transition|state|状态/i);

  const approve = await request(`/api/skills/${skill.id}/transition`, {
    method: "POST", body: JSON.stringify({ state: "approved", note: "reviewed in integration test" })
  });
  assert.equal(approve.status, 200);
  assert.equal((await approve.json()).skill.state, "approved");

  const enable = await request(`/api/skills/${skill.id}/transition`, {
    method: "POST", body: JSON.stringify({ state: "enabled", note: "approved before enable" })
  });
  assert.equal(enable.status, 200);
  assert.equal((await enable.json()).skill.state, "enabled");

  const reapprove = await request(`/api/skills/${skill.id}/transition`, {
    method: "POST", body: JSON.stringify({ state: "approved" })
  });
  assert.equal(reapprove.status, 409);

  const disable = await request(`/api/skills/${skill.id}/transition`, {
    method: "POST", body: JSON.stringify({ state: "disabled", note: "test completed" })
  });
  assert.equal(disable.status, 200);
  const disabled = (await disable.json()).skill;
  assert.equal(disabled.state, "disabled");
  assert.equal(disabled.reviewNote, "test completed");
  assert.ok(disabled.reviewedAt);

  const listing = await request("/api/skills?state=disabled&q=Lifecycle");
  assert.equal(listing.status, 200);
  const inventory = await listing.json();
  assert.equal(inventory.total, 1);
  assert.equal(inventory.skills[0].id, skill.id);
  assert.equal(inventory.skills[0].state, "disabled");
});

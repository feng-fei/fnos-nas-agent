import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";

const entry = resolve("apps/fnos-nas-agent/app/server.mjs");
let child;
let dataDir;
let baseUrl;

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}
async function waitForHealth(url) {
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(url + "/api/health");
      if (response.ok) return;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error("packaged server did not become healthy");
}

test("first-run setup stores only a salted password hash and protects session endpoints", async t => {
  dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-auth-"));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", AGENT_DATA_DIR: dataDir, AGENT_ACCESS_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise(resolveWait => setTimeout(resolveWait, 1500))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl).catch(error => { throw new Error(`${error.message}; ${stderr}`); });
  const state = await (await fetch(baseUrl + "/api/session")).json();
  assert.equal(state.setupRequired, true);

  const password = "CorrectHorseBatteryStaple!";
  const setup = await fetch(baseUrl + "/api/setup", {
    method: "POST",
    headers: { origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ password })
  });
  assert.equal(setup.status, 201);
  const passwordPath = join(dataDir, "password.json");
  const passwordRecord = JSON.parse(await readFile(passwordPath, "utf8"));
  assert.equal(passwordRecord.algorithm, "scrypt");
  assert.notEqual(passwordRecord.hash, password);
  assert.equal((await stat(passwordPath)).mode & 0o777, 0o600);

  const repeatSetup = await fetch(baseUrl + "/api/setup", {
    method: "POST",
    headers: { origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ password: "AnotherPassword!123" })
  });
  assert.equal(repeatSetup.status, 409);

  const badOrigin = await fetch(baseUrl + "/api/session", {
    method: "POST",
    headers: { origin: "http://attacker.invalid", "content-type": "application/json" },
    body: JSON.stringify({ password })
  });
  assert.equal(badOrigin.status, 403);

  const login = await fetch(baseUrl + "/api/session", {
    method: "POST",
    headers: { origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ password, remember: true })
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /Max-Age=2592000/);
  const cookie = setCookie.split(";")[0];
  const sessionPath = join(dataDir, "sessions.json");
  assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);
  const storedSessions = JSON.parse(await readFile(sessionPath, "utf8"));
  assert.equal(storedSessions.length, 1);
  assert.equal(storedSessions[0][1].expiresAt - storedSessions[0][1].createdAt, 30 * 24 * 60 * 60 * 1000);

  const noSession = await fetch(baseUrl + "/api/tools");
  assert.equal(noSession.status, 401);
  const protectedDiagnostics = await fetch(baseUrl + "/api/diagnostics");
  assert.equal(protectedDiagnostics.status, 401);
  const tools = await fetch(baseUrl + "/api/tools", { headers: { cookie } });
  assert.equal(tools.status, 200);
  const toolCatalogue = await tools.json();
  assert.equal(toolCatalogue.executionEnabled, false);
  assert.equal(toolCatalogue.readOnlyExecutionEnabled, true);
  assert.deepEqual(toolCatalogue.tools.map(tool => tool.id), ["system.status", "storage.summary", "network.interfaces"]);
  assert.ok(toolCatalogue.tools.every(tool => tool.risk === "read-only" && tool.inputSchema.additionalProperties === false));

  const hiddenToolRun = await fetch(baseUrl + "/api/tools/system.status/run", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}"
  });
  assert.equal(hiddenToolRun.status, 401);
  const wrongOriginToolRun = await fetch(baseUrl + "/api/tools/system.status/run", {
    method: "POST", headers: { cookie, origin: "http://attacker.invalid", "content-type": "application/json" }, body: "{}"
  });
  assert.equal(wrongOriginToolRun.status, 403);
  const statusToolRun = await fetch(baseUrl + "/api/tools/system.status/run", {
    method: "POST", headers: { cookie, origin: baseUrl, "content-type": "application/json" }, body: "{}"
  });
  assert.equal(statusToolRun.status, 200);
  const statusToolResult = await statusToolRun.json();
  assert.equal(statusToolResult.tool, "system.status");
  assert.ok(statusToolResult.result.cpu.logicalCores > 0);
  const invalidToolArgs = await fetch(baseUrl + "/api/tools/system.status/run", {
    method: "POST", headers: { cookie, origin: baseUrl, "content-type": "application/json" }, body: JSON.stringify({ command: "id" })
  });
  assert.equal(invalidToolArgs.status, 400);
  const unknownToolRun = await fetch(baseUrl + "/api/tools/shell.run/run", {
    method: "POST", headers: { cookie, origin: baseUrl, "content-type": "application/json" }, body: "{}"
  });
  assert.equal(unknownToolRun.status, 404);
  const hiddenAgent = await fetch(baseUrl + "/api/agent/message", {
    method: "POST", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ text: "查看系统状态" })
  });
  assert.equal(hiddenAgent.status, 401);
  const agentStatus = await fetch(baseUrl + "/api/agent/status", { headers: { cookie } });
  assert.equal(agentStatus.status, 200);
  const agentStatusBody = await agentStatus.json();
  assert.equal(agentStatusBody.rulesFirst, true);
  assert.equal(agentStatusBody.arbitraryExecutionEnabled, false);
  assert.equal("apiKey" in agentStatusBody.model, false);
  const wrongOriginAgent = await fetch(baseUrl + "/api/agent/message", {
    method: "POST", headers: { cookie, origin: "http://attacker.invalid", "content-type": "application/json" }, body: JSON.stringify({ text: "查看系统状态" })
  });
  assert.equal(wrongOriginAgent.status, 403);
  const directAgent = await fetch(baseUrl + "/api/agent/message", {
    method: "POST", headers: { cookie, origin: baseUrl, "content-type": "application/json" }, body: JSON.stringify({ text: "查看系统状态" })
  });
  assert.equal(directAgent.status, 200);
  const directAgentBody = await directAgent.json();
  assert.equal(directAgentBody.mode, "rules");
  assert.equal(directAgentBody.status, "completed");
  assert.equal(directAgentBody.results[0].tool, "system.status");
  const diagnosticResponse = await fetch(baseUrl + "/api/diagnostics", { headers: { cookie } });
  assert.equal(diagnosticResponse.status, 200);
  const diagnostics = await diagnosticResponse.json();
  assert.equal(typeof diagnostics.system.nodeVersion, "string");
  assert.ok(diagnostics.cpu.logicalCores > 0);
  assert.ok(diagnostics.memory.totalBytes > 0);
  assert.ok(Array.isArray(diagnostics.network));
  assert.ok(Array.isArray(diagnostics.storage));
  assert.ok(diagnostics.storage.some(item => item.label === "root" && item.available));

  const hiddenSkills = await fetch(baseUrl + "/api/skills");
  assert.equal(hiddenSkills.status, 401);
  const hiddenArchiveImport = await fetch(baseUrl + "/api/skills/import", {
    method: "POST", headers: { "content-type": "application/zip" }, body: Buffer.from("not a zip")
  });
  assert.equal(hiddenArchiveImport.status, 401);
  const wrongOriginArchiveImport = await fetch(baseUrl + "/api/skills/import", {
    method: "POST", headers: { cookie, origin: "http://attacker.invalid", "content-type": "application/zip", "x-skill-name": "test" }, body: Buffer.from("not a zip")
  });
  assert.equal(wrongOriginArchiveImport.status, 403);
  const invalidArchiveImport = await fetch(baseUrl + "/api/skills/import", {
    method: "POST", headers: { cookie, origin: baseUrl, "content-type": "application/zip", "x-skill-name": "invalid-zip" }, body: Buffer.from("not a zip")
  });
  assert.equal(invalidArchiveImport.status, 400);
  const skillHash = "a".repeat(64);
  const importMetadata = await fetch(baseUrl + "/api/skills", {
    method: "POST", headers: { origin: baseUrl, cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "fnos-official", version: "1.0", sourceLabel: "official skill archive", archiveSha256: skillHash, declaredCapabilities: ["read-only"] })
  });
  assert.equal(importMetadata.status, 201);
  const skill = (await importMetadata.json()).skill;
  assert.equal(skill.state, "pending_review");
  assert.equal(skill.archiveSha256, skillHash);
  assert.equal("payload" in skill, false);
  assert.equal((await stat(join(dataDir, "skills.json"))).mode & 0o777, 0o600);

  const listSkills = await fetch(baseUrl + "/api/skills?state=pending_review", { headers: { cookie } });
  assert.equal(listSkills.status, 200);
  assert.equal((await listSkills.json()).total, 1);
  const invalidTransition = await fetch(baseUrl + "/api/skills/" + skill.id + "/transition", {
    method: "POST", headers: { origin: baseUrl, cookie, "content-type": "application/json" },
    body: JSON.stringify({ state: "enabled", note: "skip review" })
  });
  assert.equal(invalidTransition.status, 409);
  const approve = await fetch(baseUrl + "/api/skills/" + skill.id + "/transition", {
    method: "POST", headers: { origin: baseUrl, cookie, "content-type": "application/json" },
    body: JSON.stringify({ state: "approved", note: "metadata reviewed; archive not uploaded" })
  });
  assert.equal(approve.status, 200);
  const enable = await fetch(baseUrl + "/api/skills/" + skill.id + "/transition", {
    method: "POST", headers: { origin: baseUrl, cookie, "content-type": "application/json" },
    body: JSON.stringify({ state: "enabled", note: "still not executable" })
  });
  assert.equal(enable.status, 200);
  assert.equal((await enable.json()).skill.state, "enabled");
  assert.equal((await readFile(join(dataDir, "skills.json"), "utf8")).includes("payload"), false);

  const logout = await fetch(baseUrl + "/api/logout", {
    method: "POST", headers: { origin: baseUrl, cookie }
  });
  assert.equal(logout.status, 200);
  assert.equal(JSON.parse(await readFile(sessionPath, "utf8")).length, 0);
  const revoked = await fetch(baseUrl + "/api/tools", { headers: { cookie } });
  assert.equal(revoked.status, 401);
});

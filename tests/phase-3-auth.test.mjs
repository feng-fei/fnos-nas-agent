import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { makeZip, quarantineArchive, READ_ONLY_MANIFEST } from "./helpers/skill-archive.mjs";

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
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", AGENT_DATA_DIR: dataDir, AGENT_ACCESS_TOKEN: "", AGENT_MODEL_ENABLED: "false" },
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
  assert.deepEqual(toolCatalogue.tools.map(tool => tool.id), ["fnos.system.info","fnos.system.trim-version","fnos.system.kernel-version","fnos.system.hostname","fnos.system.uptime","fnos.system.all-volumes","fnos.system.volumes","fnos.file.ls","fnos.file.ls-dir","fnos.file.usage","fnos.app.list","fnos.docker.image-list","fnos.docker.stats","fnos.docker.container-list","fnos.docker.container-list-all","fnos.docker.compose-list","fnos.download.list","fnos.monitor.cpu","fnos.monitor.memory","fnos.monitor.network","fnos.monitor.disk","fnos.storage.pools","fnos.user.info","fnos.monitor.beep-supported","fnos.photos.folders","fnos.photos.search","system.status","storage.summary","system.process-summary","network.interfaces","files.list","files.preview","files.search","files.search-content","files.inspect","media.photos.search","documents.index-status","documents.search","documents.index-refresh","health-checks.list","health-checks.create","health-checks.run","health-checks.update","health-checks.delete","files.create-folder","files.rename","files.move","files.upload","files.create-text","files.delete"]);
  assert.ok(toolCatalogue.tools.every(tool => ["read-only", "write", "destructive"].includes(tool.risk) && tool.inputSchema.additionalProperties === false));
  assert.equal(toolCatalogue.routineWriteExecutionEnabled, true);
  assert.equal(toolCatalogue.destructiveActionConfirmationEnabled, true);
  assert.ok(toolCatalogue.tools.filter(tool => tool.risk === "write").every(tool => ["files.create-folder", "files.rename", "files.move", "files.upload", "files.create-text", "documents.index-refresh", "health-checks.create", "health-checks.run", "health-checks.update", "health-checks.delete"].includes(tool.id)));
  const createdSchedule = await fetch(baseUrl + "/api/health-checks", {
    method: "POST", headers: { cookie, origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ name: "API 系统巡检", type: "system", intervalMinutes: 5 })
  });
  assert.equal(createdSchedule.status, 201);
  const createdCheck = (await createdSchedule.json()).check;
  assert.equal(createdCheck.type, "system");
  const listedSchedules = await fetch(baseUrl + "/api/health-checks", { headers: { cookie } });
  assert.equal(listedSchedules.status, 200);
  assert.ok((await listedSchedules.json()).checks.some(check => check.id === createdCheck.id));
  const runSchedule = await fetch(baseUrl + "/api/health-checks/" + createdCheck.id + "/run", {
    method: "POST", headers: { cookie, origin: baseUrl }
  });
  assert.equal(runSchedule.status, 200);
  assert.equal((await runSchedule.json()).run.status, "ok");
  const pausedSchedule = await fetch(baseUrl + "/api/health-checks/" + createdCheck.id, {
    method: "PATCH", headers: { cookie, origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(pausedSchedule.status, 200);
  assert.equal((await pausedSchedule.json()).check.enabled, false);
  const removedSchedule = await fetch(baseUrl + "/api/health-checks/" + createdCheck.id, {
    method: "DELETE", headers: { cookie, origin: baseUrl }
  });
  assert.equal(removedSchedule.status, 200);
  assert.equal((await removedSchedule.json()).deleted, true);


  const pendingWithoutSession = await fetch(baseUrl + "/api/actions/pending");
  assert.equal(pendingWithoutSession.status, 401);
  const confirmWithoutSession = await fetch(baseUrl + "/api/actions/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/confirm", {
    method: "POST", headers: { origin: baseUrl, "content-type": "application/json" }
  });
  assert.equal(confirmWithoutSession.status, 401);
  const hiddenToolRun = await fetch(baseUrl + "/api/tools/system.status/run", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}"
  });
  assert.equal(hiddenToolRun.status, 401);
  const wrongOriginToolRun = await fetch(baseUrl + "/api/tools/system.status/run", {
    method: "POST", headers: { cookie, origin: "http://attacker.invalid", "content-type": "application/json" }, body: "{}"
  });
  assert.equal(wrongOriginToolRun.status, 403);
  const directDestructiveRun = await fetch(baseUrl + "/api/tools/files.delete/run", {
    method: "POST", headers: { cookie, origin: baseUrl, "content-type": "application/json" }, body: JSON.stringify({ path: "/vol1/never-delete.txt" })
  });
  assert.equal(directDestructiveRun.status, 202);
  const destructiveApproval = await directDestructiveRun.json();
  assert.equal(destructiveApproval.approvalRequired, true);
  assert.equal(destructiveApproval.approval.toolId, "files.delete");
  const pendingActions = await fetch(baseUrl + "/api/actions/pending", { headers: { cookie } });
  assert.equal(pendingActions.status, 200);
  assert.equal((await pendingActions.json()).actions.length, 1);
  const pendingDenied = await fetch(baseUrl + "/api/actions/" + destructiveApproval.approval.id + "/deny", {
    method: "POST", headers: { cookie, origin: baseUrl, "content-type": "application/json" }, body: "{}"
  });
  assert.equal(pendingDenied.status, 200);
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
  assert.equal(directAgent.status, 202);
  const acceptedTask = (await directAgent.json()).task;
  assert.ok(acceptedTask.taskId);
  assert.ok(["queued", "running"].includes(acceptedTask.status));
  const hiddenTaskList = await fetch(baseUrl + "/api/tasks");
  assert.equal(hiddenTaskList.status, 401);
  const taskStatus = await fetch(baseUrl + "/api/tasks/status", { headers: { cookie } });
  assert.equal(taskStatus.status, 200);
  assert.ok((await taskStatus.json()).retained >= 1);
  let completedTask;
  for (let i = 0; i < 40; i++) {
    const taskResponse = await fetch(baseUrl + "/api/tasks/" + acceptedTask.taskId, { headers: { cookie } });
    assert.equal(taskResponse.status, 200);
    completedTask = (await taskResponse.json()).task;
    if (completedTask.status === "completed" || completedTask.status === "failed") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(completedTask.status, "completed");
  assert.equal(completedTask.result.mode, "rules");
  assert.equal(completedTask.result.results[0].tool, "system.status");
  const taskList = await fetch(baseUrl + "/api/tasks?limit=10", { headers: { cookie } });
  assert.equal(taskList.status, 200);
  assert.ok((await taskList.json()).tasks.some(task => task.taskId === acceptedTask.taskId));
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
  // Phase 136: the server reads the quarantined archive itself and derives
  // the review verdict from those bytes, so the archive has to be in the
  // quarantine directory before the Skill can be registered.
  const skillHash = await quarantineArchive(dataDir, makeZip([{ name: "SKILL.md", data: READ_ONLY_MANIFEST }]));
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

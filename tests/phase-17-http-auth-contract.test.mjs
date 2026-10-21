import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";

async function unusedPort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test("HTTP auth contract: setup, session, origin checks and logout", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-http-contract-"));
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
  const request = (path, options = {}) => fetch(origin + path, { ...options, headers: { ...headers, ...(options.headers || {}) } });

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

  const initial = await request("/api/session");
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).setupRequired, true);

  const noOrigin = await fetch(origin + "/api/setup", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "correct-horse-battery" })
  });
  assert.equal(noOrigin.status, 403, "state-changing setup must reject missing Origin");

  const setup = await request("/api/setup", {
    method: "POST", body: JSON.stringify({ password: "correct-horse-battery" })
  });
  assert.equal(setup.status, 201, await setup.text());

  const toolsBeforeLogin = await request("/api/tools");
  assert.equal(toolsBeforeLogin.status, 401);

  const login = await request("/api/session", {
    method: "POST", body: JSON.stringify({ password: "correct-horse-battery" })
  });
  assert.equal(login.status, 200, await login.text());
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^nas_agent_session=/);

  const agentStatus = await request("/api/agent/status", { headers: { cookie } });
  assert.equal(agentStatus.status, 200);
  const agentStatusPayload = await agentStatus.json();
  assert.equal(agentStatusPayload.trimCli.configured, false);
  assert.match(agentStatusPayload.trimCli.reason, /TRIM_CLI_PATH is not configured/);

  const missingSkillInstall = await request("/api/skills/${"a".repeat(24)}/install-cli", {
    method: "POST", headers: { cookie }
  });
  assert.equal(missingSkillInstall.status, 404, "CLI install endpoint must match the route and require an existing reviewed Skill");

  const toolsAfterLogin = await request("/api/tools", { headers: { cookie } });
  assert.equal(toolsAfterLogin.status, 200);
  const toolsPayload = await toolsAfterLogin.json();
  assert.equal(toolsPayload.executionEnabled, false);
  assert.equal(toolsPayload.readOnlyExecutionEnabled, true);

  const wrongOrigin = await request("/api/agent/message", {
    method: "POST",
    headers: { cookie, origin: "http://attacker.invalid" },
    body: JSON.stringify({ text: "show system status" })
  });
  assert.equal(wrongOrigin.status, 403);

  const logout = await request("/api/logout", { method: "POST", headers: { cookie } });
  assert.equal(logout.status, 200);
  const toolsAfterLogout = await request("/api/tools", { headers: { cookie } });
  assert.equal(toolsAfterLogout.status, 401, "logout must invalidate the server-side session");
});

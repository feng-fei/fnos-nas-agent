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

test("first-run setup persists a private token and protects session endpoints", async t => {
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

  const token = "a".repeat(64);
  const setup = await fetch(baseUrl + "/api/setup", {
    method: "POST",
    headers: { origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ token })
  });
  assert.equal(setup.status, 201);
  assert.equal(await readFile(join(dataDir, "access-token"), "utf8"), token + "\n");
  assert.equal((await stat(join(dataDir, "access-token"))).mode & 0o777, 0o600);

  const repeatSetup = await fetch(baseUrl + "/api/setup", {
    method: "POST",
    headers: { origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ token: "b".repeat(64) })
  });
  assert.equal(repeatSetup.status, 409);

  const badOrigin = await fetch(baseUrl + "/api/session", {
    method: "POST",
    headers: { origin: "http://attacker.invalid", "content-type": "application/json" },
    body: JSON.stringify({ token })
  });
  assert.equal(badOrigin.status, 403);

  const login = await fetch(baseUrl + "/api/session", {
    method: "POST",
    headers: { origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ token })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];

  const noSession = await fetch(baseUrl + "/api/tools");
  assert.equal(noSession.status, 401);
  const tools = await fetch(baseUrl + "/api/tools", { headers: { cookie } });
  assert.equal(tools.status, 200);
  assert.deepEqual(await tools.json(), { tools: [], executionEnabled: false });
});

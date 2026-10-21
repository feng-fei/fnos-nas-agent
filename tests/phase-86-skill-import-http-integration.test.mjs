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

test("Skill archive import rejects unauthenticated, cross-origin and malformed ZIP requests", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-skill-http-"));
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(process.cwd(), "apps/fnos-nas-agent/app/server.mjs")], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });
  let cookie = "";
  const request = (path, options = {}) => fetch(origin + path, {
    ...options,
    headers: { origin, ...(cookie ? { cookie } : {}), ...(options.headers || {}) }
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
  assert.equal((await request("/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct-horse-battery" }) })).status, 201);
  const login = await request("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(login.status, 200);
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const url = "/api/skills/import";
  const headers = { "content-type": "application/zip", "x-skill-name": "Invalid archive test", "x-skill-version": "1.0.0" };
  const unauthenticated = await fetch(origin + url, { method: "POST", headers: { ...headers, origin }, body: "not a zip" });
  assert.equal(unauthenticated.status, 401);

  const wrongOrigin = await request(url, { method: "POST", headers: { ...headers, origin: "http://attacker.invalid" }, body: "not a zip" });
  assert.equal(wrongOrigin.status, 403);

  const wrongType = await request(url, { method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "not a zip" });
  assert.equal(wrongType.status, 415);

  const malformed = await request(url, { method: "POST", headers, body: "not a zip" });
  assert.equal(malformed.status, 400);

  const listing = await request("/api/skills?limit=10&offset=0");
  assert.equal(listing.status, 200);
  const payload = await listing.json();
  assert.equal(payload.total, 0);
  assert.deepEqual(payload.skills, []);
});

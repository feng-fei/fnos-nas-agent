import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";

async function unusedPort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test("model catalog HTTP route filters invalid and duplicate IDs without exposing credentials", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-catalog-http-"));
  let catalogCalls = 0, authHeader = "";
  const fakeProvider = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain request body */ }
    catalogCalls++;
    authHeader = req.headers.authorization || "";
    if (req.url !== "/v1/models") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal-upstream-path" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [
      { id: "model-z", owned_by: "mock-org" },
      { id: "model-a", owned_by: "mock-org" },
      { id: "model-z", owned_by: "duplicate" },
      { id: "", owned_by: "invalid" },
      { id: 42, owned_by: "invalid" },
      { id: "bad\nmodel", owned_by: "invalid" }
    ] }));
  });
  await new Promise((resolve, reject) => fakeProvider.listen(0, "127.0.0.1", resolve).once("error", reject));
  const providerPort = fakeProvider.address().port;
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
    await new Promise(resolve => fakeProvider.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  let healthy = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try { const response = await fetch(origin + "/api/health"); if (response.ok) { healthy = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true, `server did not become healthy. Output: ${output}`);
  assert.equal((await request("/api/setup", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) })).status, 201);
  const login = await request("/api/session", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(login.status, 200);
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const create = await request("/api/models", {
    method: "POST",
    body: JSON.stringify({
      name: "Catalog Mock Provider", endpoint: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
      model: "mock-model", apiKey: "catalog-secret-key", enabled: true, fallback: false
    })
  });
  assert.equal(create.status, 201, await create.clone().text());
  const provider = (await create.json()).provider;

  const crossOrigin = await request(`/api/models/${provider.id}/catalog`, {
    method: "POST", headers: { origin: "http://attacker.invalid" }
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(catalogCalls, 0);

  const response = await request(`/api/models/${provider.id}/catalog`, { method: "POST" });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.models.map(item => item.id), ["model-z", "model-a"]);
  assert.equal(payload.models[0].ownedBy, "mock-org");
  assert.equal(catalogCalls, 1);
  assert.equal(authHeader, "Bearer catalog-secret-key");
  assert.equal(JSON.stringify(payload).includes("catalog-secret-key"), false);
  assert.equal(JSON.stringify(payload).includes("internal-upstream-path"), false);
});

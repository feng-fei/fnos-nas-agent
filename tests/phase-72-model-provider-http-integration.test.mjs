import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

test("model provider CRUD and presets work over authenticated HTTP without exposing keys", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-model-http-"));
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

  assert.equal((await request("/api/models")).status, 401);
  const setup = await request("/api/setup", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(setup.status, 201, await setup.text());
  const login = await request("/api/session", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(login.status, 200, await login.text());
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const presetsResponse = await request("/api/models/presets");
  assert.equal(presetsResponse.status, 200);
  assert.equal(presetsResponse.headers.get("cache-control"), "no-store");
  const presets = (await presetsResponse.json()).presets;
  assert.ok(presets.some(item => item.id === "gemini"));
  assert.ok(presets.some(item => item.id === "groq"));
  assert.ok(presets.some(item => item.id === "ollama-local"));

  const secret = "api-key-integration-secret";
  const created = await request("/api/models", {
    method: "POST",
    body: JSON.stringify({ name: "Integration Provider", endpoint: "https://provider.example/v1/chat/completions", model: "model-test", apiKey: secret, enabled: true, fallback: false })
  });
  assert.equal(created.status, 201);
  const provider = (await created.json()).provider;
  assert.equal(provider.name, "Integration Provider");
  assert.equal(provider.hasApiKey, true);
  assert.equal(Object.hasOwn(provider, "apiKey"), false);

  const storePath = join(dataDir, "model-providers.json");
  const persisted = await readFile(storePath, "utf8");
  assert.equal(persisted.includes(secret), false);
  assert.equal((await stat(storePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dataDir, "model-provider.key"))).mode & 0o777, 0o600);

  const updated = await request("/api/models/" + provider.id, {
    method: "PUT",
    body: JSON.stringify({ name: "Updated Provider", endpoint: provider.endpoint, model: "model-test-2", apiKey: "", enabled: true, fallback: false })
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).provider.hasApiKey, true);

  const setDefault = await request("/api/models/" + provider.id + "/default", { method: "POST", body: "{}" });
  assert.equal(setDefault.status, 200, await setDefault.text());
  const list = await request("/api/models");
  assert.equal(list.status, 200);
  const listing = await list.json();
  assert.equal(listing.activeProviderId, provider.id);
  assert.equal(JSON.stringify(listing).includes(secret), false);

  const wrongOriginCatalog = await request("/api/models/" + provider.id + "/catalog", {
    method: "POST", headers: { origin: "http://attacker.invalid" }
  });
  assert.equal(wrongOriginCatalog.status, 403);

  const removed = await request("/api/models/" + provider.id, { method: "DELETE" });
  assert.equal(removed.status, 200, await removed.text());
  assert.equal((await (await request("/api/models")).json()).providers.length, 0);
});

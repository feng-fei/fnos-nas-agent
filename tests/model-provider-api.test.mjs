import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("model management API enforces session/origin, persists provider settings, and never returns the API key", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-model-api-"));
  const port = await unusedPort();
  const origin = "http://127.0.0.1:" + port;
  const serverPath = join(process.cwd(), "apps/fnos-nas-agent/app/server.mjs");
  const child = spawn(process.execPath, [serverPath], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: String(port), AGENT_MODEL_ENABLED: "false" },
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
  assert.equal(healthy, true, "server did not become healthy. Output: " + output);

  const unauth = await request("/api/models");
  assert.equal(unauth.status, 401);
  const setup = await request("/api/setup", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(setup.status, 201, await setup.text());
  const login = await request("/api/session", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(login.status, 200, await login.text());
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const presetResponse = await request("/api/models/presets", { headers: { cookie } });
  assert.equal(presetResponse.status, 200);
  const presetPayload = await presetResponse.json();
  assert.ok(presetPayload.presets.some(item => item.id === "openai"));
  assert.ok(presetPayload.presets.some(item => item.id === "deepseek"));
  assert.ok(presetPayload.presets.some(item => item.id === "siliconflow"));

  const listing = await request("/api/models", { headers: { cookie } });
  assert.equal(listing.status, 200);
  const listingPayload = await listing.json();
  assert.deepEqual(listingPayload.providers, []);
  assert.ok(listingPayload.metrics?.totals);

  const wrongOrigin = await request("/api/models", {
    method: "POST", headers: { cookie, origin: "http://attacker.invalid" },
    body: JSON.stringify({ name: "Evil", endpoint: "https://provider.example/v1/chat/completions", model: "m", apiKey: "SHOULD_NOT_SAVE" })
  });
  assert.equal(wrongOrigin.status, 403);

  const invalidEndpoint = await request("/api/models", {
    method: "POST", headers: { cookie },
    body: JSON.stringify({ name: "Invalid", endpoint: "http://provider.example/v1/chat/completions", model: "m", apiKey: "invalid-secret" })
  });
  assert.equal(invalidEndpoint.status, 400);

  const secret = "MODEL_API_KEY_SUPER_SECRET_123";
  const create = async (name, model, fallback = false) => request("/api/models", {
    method: "POST", headers: { cookie },
    body: JSON.stringify({ name, endpoint: "https://provider.example/v1/chat/completions", model, apiKey: secret, enabled: true, fallback })
  });
  const oneResponse = await create("Provider One", "model-one");
  assert.equal(oneResponse.status, 201, "provider creation should succeed");
  const oneBody = await oneResponse.json();
  const one = oneBody.provider;
  assert.ok(one.id);
  assert.equal(one.hasApiKey, true);
  assert.equal(one.isDefault, true);
  assert.equal(JSON.stringify(oneBody).includes(secret), false);

  const twoResponse = await create("Provider Two", "model-two", true);
  assert.equal(twoResponse.status, 201, "second provider creation should succeed");
  const two = (await twoResponse.json()).provider;
  assert.equal(two.isDefault, false);

  const choose = await request("/api/models/" + two.id + "/default", { method: "POST", headers: { cookie } });
  assert.equal(choose.status, 200, "default selection should succeed");
  assert.equal((await choose.json()).provider.isDefault, true);

  const update = await request("/api/models/" + one.id, {
    method: "PUT", headers: { cookie },
    body: JSON.stringify({ name: "Provider One Renamed", endpoint: one.endpoint, model: one.model, enabled: true })
  });
  assert.equal(update.status, 200, "provider update should succeed");
  assert.equal((await update.json()).provider.hasApiKey, true, "blank key keeps the encrypted key");

  const providers = await request("/api/models", { headers: { cookie } });
  const providerBody = await providers.json();
  assert.equal(providerBody.activeProviderId, two.id);
  assert.equal(providerBody.providers.length, 2);
  assert.equal(JSON.stringify(providerBody).includes(secret), false);
  assert.equal(JSON.stringify(providerBody).includes("apiKeyEncrypted"), false);
  assert.equal(JSON.stringify(providerBody).includes('"apiKey"'), false);

  const disabled = await request("/api/models/" + two.id, {
    method: "PUT", headers: { cookie },
    body: JSON.stringify({ name: "Provider Two", endpoint: two.endpoint, model: two.model, enabled: false })
  });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).provider.enabled, false);

  const encryptedOnDisk = await readFile(join(dataDir, "model-providers.json"), "utf8");
  assert.equal(encryptedOnDisk.includes(secret), false);
  assert.equal(encryptedOnDisk.includes('"apiKey"'), false);

  const removeOne = await request("/api/models/" + one.id, { method: "DELETE", headers: { cookie } });
  assert.equal(removeOne.status, 200);
  const removeTwo = await request("/api/models/" + two.id, { method: "DELETE", headers: { cookie } });
  assert.equal(removeTwo.status, 200);
  const empty = await request("/api/models", { headers: { cookie } });
  assert.deepEqual((await empty.json()).providers, []);
});

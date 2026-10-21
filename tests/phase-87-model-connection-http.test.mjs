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

test("model connection tests use the configured endpoint and sanitize provider failures", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-model-test-http-"));
  const fakeProvider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.match(req.headers.authorization || "", /^Bearer /);
    assert.equal(JSON.parse(body).messages[0].content, "Reply with OK.");
    if (req.url === "/bad/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream-secret-diagnostic" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
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
  const setup = await request("/api/setup", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(setup.status, 201);
  const login = await request("/api/session", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(login.status, 200);
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const createProvider = async (name, path) => {
    const response = await request("/api/models", {
      method: "POST",
      body: JSON.stringify({
        name, endpoint: `http://127.0.0.1:${providerPort}${path}`,
        model: "mock-model", apiKey: "integration-secret-key", enabled: true, fallback: false
      })
    });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).provider;
  };

  const healthyProvider = await createProvider("Local Mock Provider", "/chat/completions");
  const successResponse = await request(`/api/models/${healthyProvider.id}/test`, { method: "POST", body: "{}" });
  assert.equal(successResponse.status, 200);
  const success = await successResponse.json();
  assert.equal(success.test.ok, true);
  assert.match(success.test.message, /连接成功/);
  assert.equal(JSON.stringify(success).includes("integration-secret-key"), false);

  const malformedProvider = await createProvider("Malformed Mock Provider", "/bad/chat/completions");
  const failureResponse = await request(`/api/models/${malformedProvider.id}/test`, { method: "POST", body: "{}" });
  assert.equal(failureResponse.status, 200);
  const failure = await failureResponse.json();
  assert.equal(failure.test.ok, false);
  assert.match(failure.test.message, /格式/);
  assert.equal(JSON.stringify(failure).includes("upstream-secret-diagnostic"), false);
  assert.equal(JSON.stringify(failure).includes("integration-secret-key"), false);

  const persisted = await (await request("/api/models")).json();
  assert.equal(persisted.providers.find(item => item.id === healthyProvider.id).lastTest.ok, true);
  assert.equal(persisted.providers.find(item => item.id === malformedProvider.id).lastTest.ok, false);
});

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

test("task cancellation HTTP route cancels queued work and enforces session/origin", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-task-cancel-"));
  const fakeProvider = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain request body */ }
    await new Promise(resolve => setTimeout(resolve, 1800));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "No tools are required for this test." } }] }));
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

  const providerResponse = await request("/api/models", {
    method: "POST",
    body: JSON.stringify({
      name: "Slow Test Provider", endpoint: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
      model: "slow-test-model", apiKey: "test-key", enabled: true, fallback: false
    })
  });
  assert.equal(providerResponse.status, 201, await providerResponse.clone().text());
  const provider = (await providerResponse.json()).provider;
  assert.equal((await request(`/api/models/${provider.id}/default`, { method: "POST", body: "{}" })).status, 200);

  const submit = async text => {
    const response = await request("/api/agent/message", { method: "POST", body: JSON.stringify({ text }) });
    assert.equal(response.status, 202, await response.clone().text());
    return (await response.json()).task;
  };
  const tasks = await Promise.all([
    submit("请分析当前 NAS 的运行状态并提出建议。"),
    submit("请帮助我判断 NAS 存储使用情况并提出建议。"),
    submit("请总结 NAS 的整体健康情况并提出建议。")
  ]);
  assert.equal(tasks.length, 3);
  const queued = await request(`/api/tasks/${tasks[2].taskId}`);
  assert.equal(queued.status, 200);
  assert.equal((await queued.json()).task.status, "queued");

  const blockedOrigin = await request(`/api/tasks/${tasks[2].taskId}/cancel`, {
    method: "POST", headers: { origin: "http://attacker.invalid" }
  });
  assert.equal(blockedOrigin.status, 403);

  const cancelled = await request(`/api/tasks/${tasks[2].taskId}/cancel`, { method: "POST", body: "{}" });
  assert.equal(cancelled.status, 200);
  const cancelledPayload = await cancelled.json();
  assert.equal(cancelledPayload.cancelled, true);
  assert.equal(cancelledPayload.task.status, "cancelled");

  const missing = await request("/api/tasks/00000000-0000-4000-8000-000000000000/cancel", { method: "POST", body: "{}" });
  assert.equal(missing.status, 404);
});

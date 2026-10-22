import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createTcpServer } from "node:net";
import { createServer as createHttpServer } from "node:http";

async function unusedPort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

// A minimal OpenAI compatible upstream. It answers the stream grammar the
// chat adapter speaks: "data: <json>" per line and "[DONE]" closes it.
function startFakeUpstream(chunks) {
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk.toString(); });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      for (const chunk of chunks) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function readEvents(response) {
  const text = await response.text();
  const events = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const lines = frame.split(/\r?\n/).filter(line => line.length);
    if (!lines.length) continue;
    let name = "message";
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("event:")) name = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
    }
    if (!dataLines.length) continue;
    const payload = dataLines.join("\n");
    let data;
    try { data = JSON.parse(payload); } catch { data = { raw: payload }; }
    events.push({ event: name, data });
  }
  return events;
}

test("the direct chat channel streams a model answer over authenticated HTTP", async t => {
  const dataDir = resolve(mkdtempSync(join(tmpdir(), "fnos-chat-http-")));
  const upstream = await startFakeUpstream(["你好", "，我是测试模型。"]);
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
    upstream.server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  let healthy = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try { const response = await fetch(origin + "/api/health"); if (response.ok) { healthy = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true, `server did not become healthy. Output: ${output}`);

  // The chat channel is protected exactly like every other API route.
  assert.equal((await request("/api/chat/status")).status, 401);
  assert.equal((await request("/api/chat/message", { method: "POST", body: JSON.stringify({ messages: [] }) })).status, 401);

  const setup = await request("/api/setup", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(setup.status, 201, await setup.text());
  const login = await request("/api/session", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(login.status, 200, await login.text());
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  // Without a provider the channel reports that it is not configured, it does
  // not answer with an empty stream.
  const statusWithoutProvider = await request("/api/chat/status");
  assert.equal(statusWithoutProvider.status, 200);
  const disabled = await statusWithoutProvider.json();
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.providerConfigured, false);

  const created = await request("/api/models", {
    method: "POST",
    body: JSON.stringify({
      name: "Chat Provider",
      endpoint: `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
      model: "chat-test-model",
      apiKey: "chat-test-key",
      enabled: true,
      fallback: false
    })
  });
  const createdText = await created.text();
  assert.equal(created.status, 201, createdText);
  const provider = JSON.parse(createdText).provider;
  const madeDefault = await request(`/api/models/${provider.id}/default`, { method: "POST" });
  assert.equal(madeDefault.status, 200, await madeDefault.text());

  const enabled = await (await request("/api/chat/status")).json();
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.model, "chat-test-model");

  // A wrong body is rejected before the stream starts.
  assert.equal((await request("/api/chat/message", { method: "POST", body: JSON.stringify({ messages: "no" }) })).status, 400);
  assert.equal((await request("/api/chat/message", {
    method: "POST", headers: { "content-type": "text/plain" }, body: "hello"
  })).status, 415);

  const streamed = await request("/api/chat/message", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "你好" }] })
  });
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers.get("content-type") || "", /text\/event-stream/);
  const events = await readEvents(streamed);
  assert.deepEqual(events.filter(item => item.event === "delta").map(item => item.data.text), ["你好", "，我是测试模型。"]);
  const done = events.find(item => item.event === "done");
  assert.ok(done, "the stream must end with a done event");
  assert.equal(done.data.text, "你好，我是测试模型。");
  assert.equal(events.filter(item => item.event === "error").length, 0);

  // A foreign origin is refused, the stream does not start.
  const foreign = await fetch(origin + "/api/chat/message", {
    method: "POST",
    headers: { origin: "http://evil.example", "content-type": "application/json", cookie },
    body: JSON.stringify({ messages: [{ role: "user", content: "你好" }] })
  });
  assert.equal(foreign.status, 403);
});

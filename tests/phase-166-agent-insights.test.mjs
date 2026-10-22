import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import { estimateTokens, buildUsageEntry, createSystemCollector } from "../apps/fnos-nas-agent/app/agent-insights.mjs";
import { createUsageMeter, applyPrivacyMode } from "../apps/fnos-nas-agent/app/model-usage.mjs";

test("estimateTokens counts an estimate and never throws on a strange input", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a".repeat(400)), 100);
});

test("buildUsageEntry needs an attributable provider and keeps the counters only", () => {
  assert.equal(buildUsageEntry({ model: "m" }), null);
  const entry = buildUsageEntry({
    provider: "local", model: "qwen", outcome: "ok",
    promptText: "a".repeat(40), completionText: "b".repeat(80), latencyMs: 12.4, privacyMode: true
  });
  assert.equal(entry.provider, "local");
  assert.equal(entry.promptTokens, 10);
  assert.equal(entry.completionTokens, 20);
  assert.equal(entry.latencyMs, 12);
  assert.equal(entry.privacyMode, true);
  assert.equal(entry.outcome, "ok");
  assert.equal(JSON.stringify(entry).includes("a".repeat(40)), false, "the record must not keep the prompt");
});

test("the usage meter counts the records and reports an incomplete price as unpriced", () => {
  const meter = createUsageMeter({ maxEntries: 5 });
  meter.record({ provider: "local", model: "m1", outcome: "ok", promptTokens: 10, completionTokens: 5, latencyMs: 20, local: true });
  meter.record({ provider: "cloud", model: "m2", outcome: "error", promptTokens: 3, latencyMs: 40 });
  const summary = meter.summary();
  assert.equal(summary.requests, 2);
  assert.equal(summary.ok, 1);
  assert.equal(summary.error, 1);
  assert.equal(summary.promptTokens, 13);
  assert.equal(summary.localRequests, 1);
  assert.equal(summary.cloudRequests, 1);
  assert.equal(summary.priced, false, "an unknown price must stay unpriced");
  const privacy = applyPrivacyMode(summary, { privacyMode: true });
  assert.equal(privacy.privacyMode, true);
  assert.equal(privacy.cloudRequestsBlocked, 1);
});

test("the system collector reads the official CLI and reports a missing source as unavailable", async () => {
  const fakeCli = {
    async runReadOnly(id) {
      if (id === "monitor.cpu") return { command: id, data: { usagePercent: 42, temperatureC: 51 } };
      if (id === "monitor.memory") return { command: id, data: { totalBytes: 1000, usedBytes: 250 } };
      throw Object.assign(new Error("not configured"), { statusCode: 503 });
    }
  };
  const collector = createSystemCollector({ trimCli: fakeCli });
  const cpu = await collector.collect("cpu");
  assert.equal(cpu.status, "ok");
  assert.equal(cpu.values.usagePercent, 42);
  assert.equal(cpu.values.temperatureC, 51);
  const memory = await collector.collect("memory");
  assert.equal(memory.status, "ok");
  assert.equal(memory.values.usedPercent, 25);
  const docker = await collector.collect("docker");
  assert.notEqual(docker.status, "ok");
  assert.ok(docker.note, "a section that could not be measured must say so");

  const withoutCli = createSystemCollector({ trimCli: null });
  const services = await withoutCli.collect("services");
  assert.notEqual(services.status, "ok");
});

test("the MCP stdio entry answers the JSON-RPC handshake and publishes read-only tools only", async t => {
  const entry = join(process.cwd(), "apps/fnos-nas-agent/app/mcp-stdio-entry.mjs");
  const child = spawn(process.execPath, [entry], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !stdout.includes('"id":2')) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const lines = stdout.split("\n").map(line => line.trim()).filter(Boolean);
  const frames = lines.map(line => JSON.parse(line));
  const init = frames.find(frame => frame.id === 1);
  assert.equal(init.result.protocolVersion, "2024-11-05");
  assert.equal(init.result.serverInfo.name, "fnos-nas-agent");
  const list = frames.find(frame => frame.id === 2);
  assert.ok(Array.isArray(list.result.tools));
  assert.ok(list.result.tools.length > 0, "the read-only catalogue must not be empty");
});

test("the observation routes require a session and answer with the documented shape", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-insights-"));
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

  for (const path of ["/api/system/snapshot", "/api/security/inspection", "/api/models/usage"]) {
    const anonymous = await request(path);
    assert.equal(anonymous.status, 401, `${path} must require a session`);
  }

  const setup = await request("/api/setup", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(setup.status, 201, await setup.text());
  const login = await request("/api/session", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(login.status, 200, await login.text());
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const snapshot = await request("/api/system/snapshot", { headers: { cookie } });
  assert.equal(snapshot.status, 200);
  const snapshotPayload = await snapshot.json();
  assert.equal(snapshotPayload.sections.length, 6);
  assert.ok(snapshotPayload.generatedAt);
  assert.ok(snapshotPayload.uncovered.length >= 1, "the uncovered S-numbers must stay visible");

  const inspection = await request("/api/security/inspection", { headers: { cookie } });
  assert.equal(inspection.status, 200);
  const inspectionPayload = await inspection.json();
  assert.equal(inspectionPayload.sections.length, 6);
  assert.ok(Array.isArray(inspectionPayload.toolPermissions));
  assert.ok(inspectionPayload.toolPermissions.every(entry => typeof entry.tool === "string"));
  assert.ok(inspectionPayload.auditSummary);

  const usage = await request("/api/models/usage", { headers: { cookie } });
  assert.equal(usage.status, 200);
  const usagePayload = await usage.json();
  assert.equal(usagePayload.summary.requests, 0);
  assert.equal(usagePayload.privacy.enabled, false);

  const wrongOrigin = await request("/api/diagnostics/report", {
    method: "POST", headers: { cookie, origin: "http://attacker.invalid" },
    body: JSON.stringify({ symptom: "the file browser is empty" })
  });
  assert.equal(wrongOrigin.status, 403, "the diagnostic report must enforce same-origin");

  const report = await request("/api/diagnostics/report", {
    method: "POST", headers: { cookie },
    body: JSON.stringify({ symptom: "the file browser is empty", evidence: [{ source: "app.log", detail: "permission denied" }] })
  });
  assert.equal(report.status, 200);
  const reportPayload = await report.json();
  assert.ok(reportPayload.report, "the report must contain the readable text");
  assert.ok(Array.isArray(reportPayload.nextSteps));
  assert.equal(JSON.stringify(reportPayload.nextSteps).includes("rm -rf"), false);
});

test("the overview page exposes the observation panel and wires it to the three routes", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(join(process.cwd(), "apps/fnos-nas-agent/app/ui/index.html"), "utf8");
  const script = await readFile(join(process.cwd(), "apps/fnos-nas-agent/app/ui/pages.js"), "utf8");
  for (const id of ["insights-refresh", "insights-system", "insights-security", "insights-usage", "insights-status"]) {
    assert.ok(html.includes(`id="${id}"`), `the page must carry #${id}`);
  }
  assert.ok(script.includes("/api/system/snapshot"));
  assert.ok(script.includes("/api/security/inspection"));
  assert.ok(script.includes("/api/models/usage"));
  assert.ok(script.includes('document.querySelector("#insights-refresh")'), "the refresh button must be wired");
  assert.equal(script.includes("innerHTML"), false, "the observation panel must not use innerHTML");
});

async function unusedPort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

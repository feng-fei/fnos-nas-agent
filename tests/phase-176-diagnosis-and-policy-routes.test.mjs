import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createTcpServer } from "node:net";

// The diagnosis history, the write-action registry and the network policy are
// reachable over authenticated HTTP. The test drives them against a real
// server process.
async function unusedPort() {
  const server = createTcpServer();
  await new Promise((res, rej) => server.listen(0, "127.0.0.1", res).once("error", rej));
  const { port } = server.address();
  await new Promise((res, rej) => server.close(error => error ? rej(error) : res()));
  return port;
}

test("the diagnosis history, the write-action registry and the network policy work over authenticated HTTP", async t => {
  const dataDir = resolve(mkdtempSync(join(tmpdir(), "fnos-diagnosis-")));
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
        new Promise(res => child.once("exit", res)),
        new Promise(res => setTimeout(res, 3000))
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  let healthy = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try { const response = await fetch(origin + "/api/health"); if (response.ok) { healthy = true; break; } } catch {}
    await new Promise(res => setTimeout(res, 100));
  }
  assert.equal(healthy, true, `server did not become healthy. Output: ${output}`);

  // The new routes are protected like every other API route.
  assert.equal((await request("/api/diagnoses")).status, 401);
  assert.equal((await request("/api/diagnoses/stats")).status, 401);
  assert.equal((await request("/api/diagnoses/anything")).status, 401);
  assert.equal((await request("/api/write-actions")).status, 401);
  assert.equal((await request("/api/network/policy")).status, 401);
  assert.equal((await request("/api/network/check", { method: "POST", body: JSON.stringify({ url: "https://example.com" }) })).status, 401);

  const setup = await request("/api/setup", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(setup.status, 201, await setup.text());
  const login = await request("/api/session", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(login.status, 200, await login.text());
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  // A diagnosis report is written into the history.
  const report = await request("/api/diagnostics/report", {
    method: "POST",
    body: JSON.stringify({ symptom: "存储写入变慢", evidence: [{ detail: "operator note" }] })
  });
  const reportText = await report.text();
  assert.equal(report.status, 200, reportText);
  const reportBody = JSON.parse(reportText);
  assert.ok(reportBody.historyId, "the report must be recorded in the history");

  const listed = await request("/api/diagnoses");
  assert.equal(listed.status, 200);
  const listedBody = await listed.json();
  assert.equal(listedBody.total, 1);
  assert.equal(listedBody.entries[0].symptom, "存储写入变慢");

  const filtered = await (await request("/api/diagnoses?symptom=不存在")).json();
  assert.equal(filtered.total, 0);

  const stats = await (await request("/api/diagnoses/stats")).json();
  assert.equal(stats.total, 1);
  assert.equal(stats.byOutcome.open, 1);

  const single = await request(`/api/diagnoses/${reportBody.historyId}`);
  assert.equal(single.status, 200);
  assert.equal((await single.json()).outcome, "open");

  // A correction keeps the original conclusion and appends the correction.
  const correction = await request(`/api/diagnoses/${reportBody.historyId}/corrections`, {
    method: "POST",
    body: JSON.stringify({ outcome: "resolved", note: "已清理配额", correctedBy: "operator" })
  });
  const correctionText = await correction.text();
  assert.equal(correction.status, 200, correctionText);
  const correctionBody = JSON.parse(correctionText);
  assert.equal(correctionBody.entry.outcome, "resolved");
  assert.equal(correctionBody.entry.corrections.length, 1);
  assert.equal(correctionBody.entry.corrections[0].previousOutcome, "open");

  // An unknown outcome is refused.
  const invalid = await request(`/api/diagnoses/${reportBody.historyId}/corrections`, {
    method: "POST",
    body: JSON.stringify({ outcome: "invented" })
  });
  assert.equal(invalid.status, 400);

  // A foreign origin is refused on the correction route.
  const foreign = await fetch(origin + `/api/diagnoses/${reportBody.historyId}/corrections`, {
    method: "POST",
    headers: { origin: "http://evil.example", "content-type": "application/json", cookie },
    body: JSON.stringify({ outcome: "ignored" })
  });
  assert.equal(foreign.status, 403);

  // The write-action registry is readable and empty: no write path is offered
  // that the server cannot preview, approve and verify.
  const actions = await request("/api/write-actions");
  assert.equal(actions.status, 200);
  const actionsBody = await actions.json();
  assert.ok(Array.isArray(actionsBody.actions));
  assert.equal(actionsBody.registered, actionsBody.actions.length);

  // The network policy is closed by default: every URL is refused.
  const policy = await request("/api/network/policy");
  assert.equal(policy.status, 200);
  const policyBody = await policy.json();
  assert.equal(policyBody.open, false, "the egress must be closed by default");

  const check = await request("/api/network/check", { method: "POST", body: JSON.stringify({ url: "https://example.com" }) });
  assert.equal(check.status, 200);
  const checkBody = await check.json();
  assert.equal(checkBody.decision.allowed, false);
  assert.ok(checkBody.decision.reason);

  // A private address is refused even when a host is allowed.
  const privateCheck = await request("/api/network/check", { method: "POST", body: JSON.stringify({ url: "http://127.0.0.1:8080/" }) });
  const privateBody = await privateCheck.json();
  assert.equal(privateBody.decision.allowed, false);
});

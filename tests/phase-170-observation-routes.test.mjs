import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createTcpServer } from "node:net";

// The observation routes are the read-only face of the migration: the runbook
// store, the evidence of the diagnosis engine. The test drives them over real
// HTTP against a real server process.
async function unusedPort() {
  const server = createTcpServer();
  await new Promise((res, rej) => server.listen(0, "127.0.0.1", res).once("error", rej));
  const { port } = server.address();
  await new Promise((res, rej) => server.close(error => error ? rej(error) : res()));
  return port;
}

test("the runbook routes and the diagnostic evidence route work over authenticated HTTP", async t => {
  const dataDir = resolve(mkdtempSync(join(tmpdir(), "fnos-observation-")));
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

  // Every new route is protected like every other API route.
  assert.equal((await request("/api/runbooks")).status, 401);
  assert.equal((await request("/api/runbooks/stats")).status, 401);
  assert.equal((await request("/api/runbooks/anything")).status, 401);
  assert.equal((await request("/api/diagnostics/evidence")).status, 401);

  const setup = await request("/api/setup", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  const setupText = await setup.text();
  assert.equal(setup.status, 201, setupText);
  const login = await request("/api/session", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  const loginText = await login.text();
  assert.equal(login.status, 200, loginText);
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  // A runbook is written, a credential that slipped into the text is redacted
  // and the original text is not stored.
  const created = await request("/api/runbooks", {
    method: "POST",
    body: JSON.stringify({
      id: "disk-full-check",
      title: "磁盘满排查",
      tags: ["storage"],
      body: "检查 df 与 quota。apiKey = sk-live-should-not-be-stored",
      source: "operator"
    })
  });
  const createdText = await created.text();
  assert.equal(created.status, 201, createdText);
  const createdBody = JSON.parse(createdText);
  assert.ok(Array.isArray(createdBody.redactedFields), "the route must report the redacted fields");
  assert.ok(createdBody.redactedFields.length >= 1, "the credential in the body must be reported");
  assert.doesNotMatch(JSON.stringify(createdBody), /sk-live-should-not-be-stored/);

  // The same id is not overwritten.
  const duplicate = await request("/api/runbooks", {
    method: "POST",
    body: JSON.stringify({ id: "disk-full-check", title: "again", body: "again" })
  });
  const duplicateText = await duplicate.text();
  assert.equal(duplicate.status, 409, duplicateText);

  // An invalid entry is refused with the reason.
  const invalid = await request("/api/runbooks", {
    method: "POST",
    body: JSON.stringify({ id: "Not Valid", title: "", body: "" })
  });
  assert.equal(invalid.status, 400);

  // Reading, listing and searching.
  const listed = await (await request("/api/runbooks")).json();
  assert.equal(listed.total, 1);
  assert.equal(listed.entries[0].id, "disk-full-check");
  const single = await request("/api/runbooks/disk-full-check");
  assert.equal(single.status, 200);
  assert.equal((await single.json()).title, "磁盘满排查");
  assert.equal((await request("/api/runbooks/unknown-id")).status, 404);
  const searched = await (await request("/api/runbooks?q=磁盘")).json();
  assert.equal(searched.total, 1);
  assert.equal(searched.results[0].id, "disk-full-check");
  const stats = await (await request("/api/runbooks/stats")).json();
  assert.equal(stats.count, 1);
  assert.ok(Array.isArray(stats.tags));

  // The evidence route answers with the collected evidence.
  const evidence = await request("/api/diagnostics/evidence");
  assert.equal(evidence.status, 200);
  const evidenceBody = await evidence.json();
  assert.ok(Array.isArray(evidenceBody.evidence));

  // The diagnosis report merges the evidence of the server with the evidence
  // of the operator.
  const report = await request("/api/diagnostics/report", {
    method: "POST",
    body: JSON.stringify({ symptom: "存储写入变慢", evidence: [{ detail: "operator note" }] })
  });
  const reportText = await report.text();
  assert.equal(report.status, 200, reportText);
  const reportBody = JSON.parse(reportText);
  assert.ok(reportBody.evidenceSummary, "the report must name the evidence summary");
  assert.ok(reportBody.causes, "the report must keep its cause list");

  // A foreign origin is refused on the write route.
  const foreign = await fetch(origin + "/api/runbooks", {
    method: "POST",
    headers: { origin: "http://evil.example", "content-type": "application/json", cookie },
    body: JSON.stringify({ id: "foreign", title: "foreign", body: "foreign" })
  });
  assert.equal(foreign.status, 403);

  // The workflow routes list the prepared plans and run them.
  const workflows = await request("/api/workflows");
  assert.equal(workflows.status, 200);
  const workflowBody = await workflows.json();
  assert.ok(Array.isArray(workflowBody.workflows));
  assert.ok(workflowBody.workflows.length >= 2, "the shipped plans must be listed");
  assert.ok(workflowBody.workflows.every(item => item.id && item.name));

  const unknownWorkflow = await request("/api/workflows", {
    method: "POST",
    body: JSON.stringify({ workflowId: "does-not-exist" })
  });
  assert.equal(unknownWorkflow.status, 404);

  const run = await request("/api/workflows", {
    method: "POST",
    body: JSON.stringify({ workflowId: "storage-health" })
  });
  const runText = await run.text();
  assert.equal(run.status, 200, runText);
  const runBody = JSON.parse(runText);
  assert.equal(runBody.started, true);
  assert.ok(Array.isArray(runBody.steps));
  assert.ok(["completed", "partial", "failed"].includes(runBody.status));

  const events = await request("/api/workflows/storage-health/events");
  assert.equal(events.status, 200);
  assert.ok(Array.isArray((await events.json()).events));

  // The entry is removed again.
  const removed = await request("/api/runbooks/disk-full-check", { method: "DELETE" });
  const removedText = await removed.text();
  assert.equal(removed.status, 200, removedText);
  assert.equal((await request("/api/runbooks/disk-full-check")).status, 404);
});

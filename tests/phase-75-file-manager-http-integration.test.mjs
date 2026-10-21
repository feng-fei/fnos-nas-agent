import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

test("file manager batch HTTP operations stay inside an isolated configured root", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-files-http-"));
  const volumeRoot = join(dataDir, "test-volume");
  await mkdir(volumeRoot);
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const serverPath = join(process.cwd(), "apps/fnos-nas-agent/app/server.mjs");
  const child = spawn(process.execPath, [serverPath], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_DATA_DIR: dataDir, AGENT_FILE_ROOTS: volumeRoot, HOST: "127.0.0.1", PORT: String(port) },
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
  assert.equal((await request("/api/setup", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) })).status, 201);
  const login = await request("/api/session", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(login.status, 200);
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const outside = await request("/api/files?path=%2Fetc");
  assert.equal(outside.status, 403);

  const noOrigin = await request("/api/files/operations/batch", {
    method: "POST", headers: { origin: "http://attacker.invalid" },
    body: JSON.stringify({ operations: [{ action: "mkdir", path: volumeRoot, name: "blocked" }] })
  });
  assert.equal(noOrigin.status, 403);

  const batch = await request("/api/files/operations/batch", {
    method: "POST",
    body: JSON.stringify({ operations: [
      { action: "mkdir", path: volumeRoot, name: "folderA" },
      { action: "mkdir", path: volumeRoot, name: "folderA" },
      { action: "delete", path: volumeRoot, confirm: true }
    ] })
  });
  assert.equal(batch.status, 200, await batch.clone().text());
  const result = await batch.json();
  assert.equal(result.total, 3);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
  assert.equal(result.results[2].ok, false);
  assert.equal(JSON.stringify(result).includes(volumeRoot), false);

  const listing = await request("/api/files?path=" + encodeURIComponent(volumeRoot));
  assert.equal(listing.status, 200);
  const files = await listing.json();
  assert.ok(files.entries.some(entry => entry.name === "folderA" && entry.type === "directory"));
});

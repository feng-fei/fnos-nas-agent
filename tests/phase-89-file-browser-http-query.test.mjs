import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("file browser HTTP filters, sorting and pagination compose consistently", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-file-query-"));
  const volumeRoot = join(dataDir, "volume");
  await mkdir(join(volumeRoot, "folder"), { recursive: true });
  await writeFile(join(volumeRoot, "alpha.txt"), "alpha");
  await writeFile(join(volumeRoot, "beta.txt"), "beta");
  await writeFile(join(volumeRoot, "gamma.log"), "gamma longer");
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
  const setup = await request("/api/setup", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(setup.status, 201);
  const login = await request("/api/session", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(login.status, 200);
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const sorted = await request("/api/files?path=" + encodeURIComponent(volumeRoot) + "&sort=name-asc&limit=2&offset=1");
  assert.equal(sorted.status, 200);
  const sortedPayload = await sorted.json();
  assert.equal(sortedPayload.totalEntries, 4);
  assert.equal(sortedPayload.limit, 2);
  assert.equal(sortedPayload.offset, 1);
  assert.deepEqual(sortedPayload.entries.map(entry => entry.name), ["beta.txt", "folder"]);

  const filtered = await request("/api/files?path=" + encodeURIComponent(volumeRoot) + "&q=ALPHA&type=file&sort=name-desc");
  assert.equal(filtered.status, 200);
  const filteredPayload = await filtered.json();
  assert.equal(filteredPayload.totalEntries, 1);
  assert.deepEqual(filteredPayload.entries.map(entry => entry.name), ["alpha.txt"]);

  const directories = await request("/api/files?path=" + encodeURIComponent(volumeRoot) + "&type=directory");
  assert.equal(directories.status, 200);
  assert.deepEqual((await directories.json()).entries.map(entry => entry.name), ["folder"]);

  const invalidSort = await request("/api/files?path=" + encodeURIComponent(volumeRoot) + "&sort=arbitrary");
  assert.equal(invalidSort.status, 400);
  const invalidType = await request("/api/files?path=" + encodeURIComponent(volumeRoot) + "&type=symlink");
  assert.equal(invalidType.status, 400);
  const tooLongQuery = await request("/api/files?path=" + encodeURIComponent(volumeRoot) + "&q=" + "x".repeat(161));
  assert.equal(tooLongQuery.status, 400);
});

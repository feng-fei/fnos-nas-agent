import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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

test("authenticated file upload, preview and download enforce path and overwrite boundaries", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-file-transfer-"));
  const volumeRoot = join(dataDir, "volume");
  await mkdir(volumeRoot);
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(process.cwd(), "apps/fnos-nas-agent/app/server.mjs")], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_DATA_DIR: dataDir, AGENT_FILE_ROOTS: volumeRoot, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });
  let cookie = "";
  const request = (path, options = {}) => fetch(origin + path, {
    ...options,
    headers: { origin, ...(cookie ? { cookie } : {}), ...(options.headers || {}) }
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
  assert.equal((await request("/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct-horse-battery" }) })).status, 201);
  const login = await request("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(login.status, 200);
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const text = "hello from isolated upload test\nsecond line\n";
  const uploadUrl = "/api/files/upload?path=" + encodeURIComponent(volumeRoot) + "&name=" + encodeURIComponent("hello.txt");
  const uploaded = await request(uploadUrl, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: text });
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const uploadResult = await uploaded.json();
  assert.equal(uploadResult.name, "hello.txt");
  assert.equal(uploadResult.sizeBytes, Buffer.byteLength(text));
  assert.equal(await readFile(join(volumeRoot, "hello.txt"), "utf8"), text);

  const duplicate = await request(uploadUrl, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "must not overwrite" });
  assert.equal(duplicate.status, 409);
  assert.equal(await readFile(join(volumeRoot, "hello.txt"), "utf8"), text);

  const preview = await request("/api/files/preview?path=" + encodeURIComponent(join(volumeRoot, "hello.txt")));
  assert.equal(preview.status, 200);
  const previewResult = await preview.json();
  assert.equal(previewResult.name, "hello.txt");
  assert.equal(previewResult.content, text);

  const download = await request("/api/files/download?path=" + encodeURIComponent(join(volumeRoot, "hello.txt")));
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition") || "", /hello\.txt/);
  assert.equal(await download.text(), text);
  assert.equal(download.headers.get("cache-control"), "no-store");
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");

  const outside = await request("/api/files/upload?path=%2Fetc&name=blocked.txt", {
    method: "POST", headers: { "content-type": "application/octet-stream" }, body: "no"
  });
  assert.equal(outside.status, 403);

  const wrongOrigin = await request(uploadUrl, {
    method: "POST", headers: { origin: "http://attacker.invalid", "content-type": "application/octet-stream" }, body: "no"
  });
  assert.equal(wrongOrigin.status, 403);
});

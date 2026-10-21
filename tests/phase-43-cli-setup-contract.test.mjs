import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("CLI OAuth command route uses the private profile context and never executes the command", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-cli-setup-"));
  const port = await unusedPort();
  const origin = "http://127.0.0.1:" + port;
  const cliPath = join(dataDir, "stub trim-cli");
  const sentinel = join(dataDir, "cli-was-executed");
  await writeFile(cliPath, "#!/bin/sh\n: > " + JSON.stringify(sentinel) + "\nexit 0\n", { mode: 0o700 });
  await chmod(cliPath, 0o700);
  const serverPath = join(process.cwd(), "apps/fnos-nas-agent/app/server.mjs");
  const child = spawn(process.execPath, [serverPath], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: String(port), TRIM_CLI_PATH: cliPath },
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

  const setup = await request("/api/setup", {
    method: "POST", body: JSON.stringify({ password: "correct-horse-battery" })
  });
  assert.equal(setup.status, 201, await setup.text());
  const login = await request("/api/session", {
    method: "POST", body: JSON.stringify({ password: "correct-horse-battery" })
  });
  assert.equal(login.status, 200, await login.text());
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const result = await request("/api/agent/trim-cli/login-command", {
    method: "POST", headers: { cookie },
    body: JSON.stringify({ host: "nas.example.com", port: 443, scheme: "https" })
  });
  assert.equal(result.status, 200, await result.text());
  const payload = await result.json();
  assert.match(payload.command, /^'sudo' '-u' '[a-zA-Z0-9_-]+' '--' 'env' /);
  assert.ok(payload.command.includes("'HOME=" + dataDir + "'"));
  assert.ok(payload.command.includes("'XDG_CONFIG_HOME=" + join(dataDir, ".config") + "'"));
  assert.ok(payload.command.includes("'" + cliPath + "'"));
  assert.ok(payload.command.includes("'--host' 'nas.example.com' '--port' '443' '--scheme' 'https' 'login' '--no-open'"));
  assert.match(payload.note, /不会执行该命令/);
  await assert.rejects(access(sentinel), { code: "ENOENT" }, "generating a command must not execute trim-cli");
  await assert.rejects(readFile(sentinel), { code: "ENOENT" });
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";

async function unusedPort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  return port;
}

/**
 * 备份前检查是只读接口，但「只读」不等于「不设防」：
 *   1. 未登录必须 401，不能因为只读就放开；
 *   2. 未登录时也必须先被鉴权拦下，而不是落到 404。
 * 报告内容本身由 phase-217-backup-precheck.test.mjs 的纯函数用例覆盖，
 * 这里只锁网络边界。
 */
test("backup precheck route is session-gated", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-phase217-"));
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  let output = "";
  const child = spawn(process.execPath, [join(process.cwd(), "apps/fnos-nas-agent/app/server.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_DATA_DIR: dataDir,
      HOST: "127.0.0.1",
      PORT: String(port),
      FNOS_AGENT_SERVICE_COLLECTOR: "off",
      FNOS_AGENT_SMART_COLLECTOR: "off"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });

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
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(origin + "/api/health");
      if (response.ok) { healthy = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true, `server did not become healthy. Output: ${output}`);

  const anonymous = await fetch(origin + "/api/backup/precheck");
  assert.equal(anonymous.status, 401, "未登录必须 401，只读也不放开");
  const payload = await anonymous.json();
  assert.equal(payload.error, "Unauthorized");
});

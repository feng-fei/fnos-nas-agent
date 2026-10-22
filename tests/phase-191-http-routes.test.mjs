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
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

/**
 * 起一个真服务，用真 cookie 打新加的三个只读/受控接口。
 * 采集器在这里是关掉的：本机没有 systemctl，关掉后接口应如实回答 unknown，
 * 而不是假装服务健康——这正是这些断言要锁住的行为。
 */
test("runtime routes: services, capacity forecast and batch rename", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-phase191-"));
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
      FNOS_AGENT_SERVICE_COLLECTOR: "off"
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

  const request = (path, options = {}) => fetch(origin + path, {
    ...options,
    headers: { origin, "content-type": "application/json", ...(options.headers || {}) }
  });

  assert.equal((await request("/api/system/services")).status, 401);
  assert.equal((await request("/api/system/capacity-forecast")).status, 401);
  assert.equal((await request("/api/files/rename-plan", { method: "POST", body: "{}" })).status, 401);

  const setup = await request("/api/setup", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(setup.status, 201, await setup.text());
  const login = await request("/api/session", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const services = await request("/api/system/services", { headers: { cookie } });
  assert.equal(services.status, 200);
  const servicesPayload = await services.json();
  assert.equal(Array.isArray(servicesPayload.items), true);
  assert.equal(servicesPayload.items.length > 0, true);
  // 采集器被关掉：每条都必须是 unknown + no-collector，绝不能是 running。
  assert.equal(servicesPayload.items.every(item => item.verdict === "unknown"), true);
  assert.equal(servicesPayload.items.every(item => item.note === "no-collector"), true);
  assert.equal(servicesPayload.summary.verdict, "unknown");
  const services405 = await request("/api/system/services", { method: "POST", headers: { cookie }, body: "{}" });
  assert.equal(services405.status, 405);

  const forecast = await request("/api/system/capacity-forecast?horizonDays=90", { headers: { cookie } });
  assert.equal(forecast.status, 200);
  const forecastPayload = await forecast.json();
  assert.equal(forecastPayload.horizonDays, 90);
  assert.equal(Array.isArray(forecastPayload.disks), true);
  assert.equal(typeof forecastPayload.sampling.storedRecords, "number");
  assert.match(forecastPayload.note, /./);
  const clamped = await request("/api/system/capacity-forecast?horizonDays=9999", { headers: { cookie } });
  assert.equal((await clamped.json()).horizonDays, 365);

  const entries = [
    { path: "/volume1/照片/IMG 001.JPG", name: "IMG 001.JPG", kind: "file" },
    { path: "/volume1/照片/IMG 002.JPG", name: "IMG 002.JPG", kind: "file" }
  ];
  const planResponse = await request("/api/files/rename-plan", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ entries, rule: { mode: "replace", find: " ", replace: "-" } })
  });
  assert.equal(planResponse.status, 200);
  const plan = await planResponse.json();
  assert.equal(plan.ok, true);
  assert.equal(plan.plan.length, 2);
  assert.equal(plan.plan[0].to, "/volume1/照片/IMG-001.JPG");

  // 冲突：两个不同源文件争同一个目标名 → 计划不 ok，且执行前就被拦下。
  const conflicted = await request("/api/files/rename-plan", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({
      entries: [
        { path: "/volume1/照片/a 1.JPG", name: "a 1.JPG", kind: "file" },
        { path: "/volume1/照片/a1.JPG", name: "a1.JPG", kind: "file" }
      ],
      rule: { mode: "replace", find: " ", replace: "" }
    })
  });
  assert.equal(conflicted.status, 200);
  assert.equal((await conflicted.json()).ok, false);

  const noConfirm = await request("/api/files/rename-apply", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ entries, rule: { mode: "replace", find: " ", replace: "-" } })
  });
  assert.equal(noConfirm.status, 400);

  const badOrigin = await request("/api/files/rename-apply", {
    method: "POST",
    headers: { cookie, origin: "http://attacker.invalid" },
    body: JSON.stringify({ entries, rule: { mode: "replace", find: " ", replace: "-" }, confirm: true })
  });
  assert.equal(badOrigin.status, 403);
});

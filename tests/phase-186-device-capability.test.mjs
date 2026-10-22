import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import { evaluateDeviceCapabilities, DEVICE_PROFILES } from "../apps/fnos-nas-agent/app/device-capability.mjs";

const env = (overrides = {}) => ({
  platform: "linux",
  arch: "x64",
  cpuCores: 4,
  totalMemoryBytes: 8 * 1024 ** 3,
  storageType: "ssd",
  ...overrides
});

async function unusedPort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test("device capability: agent-host profile passes on a modest Linux box", () => {
  const report = evaluateDeviceCapabilities(env({ cpuCores: 4, totalMemoryBytes: 4 * 1024 ** 3, storageType: "" }), { profile: "agent-host" });
  assert.equal(report.verdict, "ready");
  assert.equal(report.profile, "agent-host");
  assert.equal(report.passed, 5);
  assert.equal(report.total, 5);
  assert.match(report.recommendation, /满足/);
});

test("device capability: local-llm profile reports per-dimension failures instead of a bare score", () => {
  const report = evaluateDeviceCapabilities(env({ cpuCores: 4, totalMemoryBytes: 16 * 1024 ** 3 }), { profile: "local-llm" });
  assert.equal(report.verdict, "partial");
  const cores = report.dimensions.find(item => item.id === "cpu_cores");
  assert.equal(cores.passed, false);
  assert.equal(cores.required, "≥ 8 核");
  assert.equal(cores.actual, "4 核");
  const memory = report.dimensions.find(item => item.id === "memory");
  assert.equal(memory.passed, true);
  assert.match(report.recommendation, /CPU 核心数/);
});

test("device capability: a hard failure (wrong platform) makes the whole profile not-ready", () => {
  const report = evaluateDeviceCapabilities(env({ platform: "win32", arch: "x64" }), { profile: "local-llm" });
  assert.equal(report.verdict, "not-ready");
  const platform = report.dimensions.find(item => item.id === "platform");
  assert.equal(platform.passed, false);
  assert.match(report.recommendation, /无法运行/);
});

test("device capability: unknown values are tri-state, never silently passed", () => {
  const report = evaluateDeviceCapabilities({}, { profile: "local-llm" });
  assert.equal(report.verdict, "partial");
  for (const item of report.dimensions) assert.equal(item.passed, null, item.id);
  const storage = report.dimensions.find(item => item.id === "storage_type");
  assert.equal(storage.actual, "未知");
  assert.match(report.recommendation, /未知/);
});

test("device capability: 32-bit architecture and hdd storage are judged, not guessed", () => {
  const report = evaluateDeviceCapabilities(env({ arch: "ia32", cpuCores: 8, storageType: "hdd" }), { profile: "local-llm" });
  assert.equal(report.verdict, "not-ready");
  const arch = report.dimensions.find(item => item.id === "architecture");
  assert.equal(arch.actual, "32 位");
  const storage = report.dimensions.find(item => item.id === "storage_type");
  assert.equal(storage.passed, false);
  assert.equal(storage.required, "固态硬盘");
});

test("device capability: unknown profile falls back to the conservative host profile", () => {
  const report = evaluateDeviceCapabilities(env(), { profile: "whatever" });
  assert.equal(report.profile, "agent-host");
  assert.ok(Object.keys(DEVICE_PROFILES).includes("local-llm"));
});

test("device capability endpoint: requires a session, validates the profile name", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-capability-data-"));
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  let output = "";
  const child = spawn(process.execPath, [join(process.cwd(), "apps/fnos-nas-agent/app/server.mjs")], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: String(port) },
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

  const headers = { origin, "content-type": "application/json" };
  const request = (path, options = {}) => fetch(origin + path, { ...options, headers: { ...headers, ...(options.headers || {}) } });

  assert.equal((await request("/api/system/capabilities")).status, 401);

  const setup = await request("/api/setup", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(setup.status, 201, await setup.text());
  const login = await request("/api/session", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const unknown = await request("/api/system/capabilities?profile=nope", { headers: { cookie } });
  assert.equal(unknown.status, 400, "an unknown profile must be rejected, not silently defaulted");

  const report = await request("/api/system/capabilities?profile=agent-host", { headers: { cookie } });
  assert.equal(report.status, 200);
  const payload = await report.json();
  assert.equal(payload.profile, "agent-host");
  assert.ok(["ready", "partial", "not-ready"].includes(payload.verdict));
  assert.equal(payload.dimensions.length, 5);
  assert.ok(payload.dimensions.every(item => typeof item.label === "string" && typeof item.required === "string"));
  const post = await request("/api/system/capabilities?profile=agent-host", { method: "POST", headers: { cookie }, body: "{}" });
  assert.equal(post.status, 405);
});

test("device capability UI entry: the overview card and the files button are shipped", async () => {
  const html = await readFile(join(process.cwd(), "apps/fnos-nas-agent/app/ui/index.html"), "utf8");
  const pages = await readFile(join(process.cwd(), "apps/fnos-nas-agent/app/ui/pages.js"), "utf8");
  assert.match(html, /id="capability-result"/);
  assert.match(html, /data-capability-profile="agent-host"/);
  assert.match(html, /data-capability-profile="local-llm"/);
  assert.match(html, /id="file-duplicates"/);
  assert.match(html, /id="file-duplicates-result"/);
  assert.match(pages, /\/api\/system\/capabilities\?profile=/);
  assert.match(pages, /\/api\/files\/duplicates\?/);
  assert.doesNotMatch(pages, /capabilityResult\.innerHTML/);
  assert.doesNotMatch(pages, /duplicateResult\.innerHTML/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createSmartctlCollector, MAX_SMART_DEVICES, SMART_ARGS } from "../apps/fnos-nas-agent/app/smart-collector.mjs";

async function unusedPort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function fakeSmartEnv({ names = ["sda", "sdb", "nvme0n1"], results = {} } = {}) {
  const calls = [];
  return {
    calls,
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      const key = args[args.length - 1];
      const result = results[key];
      if (result instanceof Error) throw result;
      if (typeof result === "string") return { stdout: result };
      if (result === undefined) return { stdout: "SMART support is: Available\n" };
      throw new Error("unexpected fake result");
    },
    readDir: () => names
  };
}

test("smart-collector: 只收白名单设备名，固定 -H -A，最多 8 块", async () => {
  const env = fakeSmartEnv({ names: ["sda", "sdb", "nvme0n1", "loop0", "md0", "sdc1"] });
  const collect = createSmartctlCollector({ exec: env.exec, readDir: env.readDir });
  const result = await collect();
  assert.deepEqual(result.devices.map((item) => item.device), ["/dev/nvme0n1", "/dev/sda", "/dev/sdb"]);
  assert.deepEqual(env.calls.map((call) => call.args), [
    ["-H", "-A", "/dev/nvme0n1"],
    ["-H", "-A", "/dev/sda"],
    ["-H", "-A", "/dev/sdb"]
  ]);
  assert.ok(env.calls.every((call) => call.options.timeout > 0 && call.options.shell === undefined));
  assert.deepEqual(result.notes, []);
  assert.equal(SMART_ARGS.join(" "), "-H -A");
  assert.equal(MAX_SMART_DEVICES, 8);
});

test("smart-collector: 非零退出但 stdout 有内容时继续解析并留痕", async () => {
  const error = new Error("exit 2");
  error.code = 2;
  error.stdout = "SMART support is: Unavailable\n";
  const env = fakeSmartEnv({ names: ["sda"], results: { "/dev/sda": error } });
  const collect = createSmartctlCollector({ exec: env.exec, readDir: env.readDir });
  const result = await collect();
  assert.equal(result.devices.length, 1);
  assert.deepEqual(result.notes, ["smart-nonzero-exit:sda"]);
});

test("smart-collector: 单盘失败不影响其它盘，全部失败时留痕 no-smart-device", async () => {
  const env = fakeSmartEnv({
    names: ["sda", "sdb"],
    results: { "/dev/sda": new Error("boom"), "/dev/sdb": "SMART support is: Available\n" }
  });
  const collect = createSmartctlCollector({ exec: env.exec, readDir: env.readDir });
  const partial = await collect();
  assert.equal(partial.devices.length, 1);
  assert.equal(partial.devices[0].device, "/dev/sdb");
  assert.match(partial.notes[0], /^smart-failed:sda:/u);

  const empty = fakeSmartEnv({ names: [], results: {} });
  const none = await createSmartctlCollector({ exec: empty.exec, readDir: empty.readDir })();
  assert.deepEqual(none, { devices: [], notes: ["no-smart-device"] });
});

test("smart-collector: 超过 8 块盘时截断并留痕", async () => {
  const names = Array.from({ length: 10 }, (_, index) => `sd${String.fromCharCode(97 + index)}`);
  const env = fakeSmartEnv({ names, results: {} });
  const collect = createSmartctlCollector({ exec: env.exec, readDir: env.readDir });
  const result = await collect();
  assert.equal(result.devices.length, MAX_SMART_DEVICES);
  assert.deepEqual(result.notes, [`devices-capped:${MAX_SMART_DEVICES}`]);
});

async function startAppServer(env = {}) {
  const dataDir = resolve(mkdtempSync(join(tmpdir(), "fnos-device-routes-")));
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(process.cwd(), "apps/fnos-nas-agent/app/server.mjs")], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) { healthy = true; break; }
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return {
    origin,
    child,
    output: () => output,
    healthy,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([new Promise((done) => child.once("exit", done)), new Promise((done) => setTimeout(done, 3000))]);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

test("the device routes require a session, reject writes and report unknown when not measured", async (t) => {
  const app = await startAppServer({
    FNOS_AGENT_THERMAL_COLLECTOR: "off",
    FNOS_AGENT_LOG_COLLECTOR: "off",
    FNOS_AGENT_SMART_COLLECTOR: "off"
  });
  t.after(() => app.stop());
  assert.equal(app.healthy, true, `server did not become healthy: ${app.output()}`);
  const cookieHeaders = { origin: app.origin, "content-type": "application/json" };
  let cookie = "";
  const request = (path, options = {}) => fetch(app.origin + path, {
    ...options,
    headers: { ...cookieHeaders, ...(cookie ? { cookie } : {}), ...(options.headers || {}) }
  });

  for (const path of ["/api/system/thermal", "/api/system/events", "/api/system/smart", "/api/system/update-check"]) {
    assert.equal((await request(path)).status, 401, `${path} must require a session`);
    assert.equal((await request(path, { method: "POST", body: "{}" })).status, 401);
  }

  const setup = await request("/api/setup", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(setup.status, 201, await setup.text());
  const login = await request("/api/session", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(login.status, 200, await login.text());
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  for (const path of ["/api/system/thermal", "/api/system/events", "/api/system/smart", "/api/system/update-check"]) {
    assert.equal((await request(path, { method: "POST", body: "{}" })).status, 405, `${path} must be GET only`);
  }

  const thermal = await (await request("/api/system/thermal")).json();
  assert.equal(thermal.verdict, "unknown");
  assert.deepEqual(thermal.readings, []);
  assert.equal(thermal.hottest, null);
  assert.ok(thermal.notes.includes("collector-disabled"));
  assert.match(thermal.note, /没测到/u);

  const events = await (await request("/api/system/events?limit=abc")).json();
  assert.equal(events.verdict, "unknown");
  assert.deepEqual(events.sources, []);
  assert.ok(events.notes.includes("collector-disabled"));

  const smart = await (await request("/api/system/smart")).json();
  assert.equal(smart.verdict, "unknown");
  assert.deepEqual(smart.devices, []);
  assert.ok(smart.notes.includes("collector-disabled"));
  assert.match(smart.note, /FNOS_AGENT_SMART_COLLECTOR=on/u);

  const available = await (await request("/api/system/update-check?latest=0.2.2&channel=stable")).json();
  assert.equal(available.status, "update-available");
  assert.equal(available.installedVersion, "0.2.1");
  assert.equal(available.current, "0.2.1");

  const unknownLatest = await (await request("/api/system/update-check")).json();
  assert.equal(unknownLatest.status, "unknown");
  assert.ok(unknownLatest.notes.includes("latest-missing"));

  const downgrade = await (await request("/api/system/update-check?latest=0.1.9")).json();
  assert.equal(downgrade.status, "unknown");
  assert.ok(downgrade.notes.includes("downgrade-not-offered"));

  const badChannel = await request("/api/system/update-check?latest=0.2.2&channel=nightly");
  assert.equal(badChannel.status, 400);
});

test("the device routes stay honest when the platform cannot measure anything", async (t) => {
  if (process.platform !== "win32") {
    t.skip("this assertion is about a host without /sys/class/thermal or readable logs");
    return;
  }
  const app = await startAppServer({});
  t.after(() => app.stop());
  assert.equal(app.healthy, true, `server did not become healthy: ${app.output()}`);
  const headers = { origin: app.origin, "content-type": "application/json" };
  let cookie = "";
  const request = (path, options = {}) => fetch(app.origin + path, {
    ...options,
    headers: { ...headers, ...(cookie ? { cookie } : {}), ...(options.headers || {}) }
  });
  await request("/api/setup", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  const login = await request("/api/session", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const thermal = await (await request("/api/system/thermal")).json();
  assert.equal(thermal.verdict, "unknown");
  assert.ok(thermal.notes.includes("collector-failed"), `notes: ${JSON.stringify(thermal.notes)}`);

  const events = await (await request("/api/system/events")).json();
  assert.equal(events.verdict, "unknown");
  assert.ok(events.notes.some((note) => note.startsWith("unreadable:")), `notes: ${JSON.stringify(events.notes)}`);
});

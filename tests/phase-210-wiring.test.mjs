import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";

async function unusedPort() {
  const server = createTcpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// 这一层测的是「新模块有没有真的接到 HTTP 上」：纯函数层各自的用例在
// phase-203…209 里，这里只保证 server 的接线不是摆设。
async function startServer() {
  const dataDir = await mkdtemp(join(tmpdir(), "phase-210-"));
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(process.cwd(), "apps/fnos-nas-agent/app/server.mjs")], {
    env: {
      ...process.env,
      AGENT_DATA_DIR: dataDir,
      HOST: "127.0.0.1",
      PORT: String(port),
      FNOS_AGENT_SERVICE_COLLECTOR: "off",
      FNOS_AGENT_DOCKER_STATS_COLLECTOR: "off"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !/listening/i.test(output)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!/listening/i.test(output)) throw new Error(`server did not start: ${output}`);
  const request = (path, options = {}) => fetch(`${origin}${path}`, {
    method: options.method ?? "GET",
    headers: {
      origin,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.headers ?? {})
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
  const setup = await request("/api/setup", { method: "POST", body: { password: "correct-horse-battery" } });
  assert.equal(setup.status, 201, "first-run setup");
  const login = await request("/api/session", { method: "POST", body: { password: "correct-horse-battery" } });
  assert.equal(login.status, 200, "login");
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  return { origin, cookie, dataDir, request, stop: async () => { child.kill(); await rm(dataDir, { recursive: true, force: true }); } };
}

test("phase-210: 203–209 的新模块都通过 HTTP 暴露，且测不到时如实说 unknown", async (t) => {
  const server = await startServer();
  t.after(async () => { await server.stop(); });
  const { cookie, request } = server;

  // Phase 203：七个系统事实工具真的进了工具注册表。
  const tools = await request("/api/tools", { cookie });
  assert.equal(tools.status, 200);
  const ids = (await tools.json()).tools.map((tool) => tool.id);
  for (const id of ["services.list", "smart.summary", "thermal.status", "events.recent", "snapshot.summary", "capabilities.get", "capacity.forecast"]) {
    assert.ok(ids.includes(id), `missing system tool ${id}`);
  }
  const run = await request("/api/tools/services.list/run", { method: "POST", cookie, body: {} });
  assert.equal(run.status, 200);
  const runBody = await run.json();
  assert.equal(runBody.tool, "services.list");
  assert.equal(runBody.result?.ok, true, "system tool runs through the registry");

  // Phase 204：采集器被环境变量关掉时要报 collector-disabled，不能假装健康。
  const stats = await request("/api/docker/stats", { cookie });
  assert.equal(stats.status, 200);
  const statsBody = await stats.json();
  assert.equal(statsBody.notes.includes("collector-disabled"), true);
  assert.equal(statsBody.summary !== undefined, true);

  // Phase 205：Windows 上没有 /proc/net/dev，必须回 unknown 而不是 0 吞吐。
  const interfaces = await request("/api/network/interfaces", { cookie });
  assert.equal(interfaces.status, 200);
  const ifaceBody = await interfaces.json();
  assert.equal(ifaceBody.verdict, "unknown");
  assert.deepEqual(ifaceBody.interfaces, []);

  // Phase 207：日志证据路由存在并回结构化结果；读不到日志时说明「没有读到」而不是报健康。
  const logEvidence = await request("/api/diagnostics/log-evidence", { cookie });
  assert.equal(logEvidence.status, 200);
  const logBody = await logEvidence.json();
  assert.equal(Array.isArray(logBody.evidence.evidence), true);
  assert.equal(typeof logBody.note, "string");
  assert.equal(Array.isArray(logBody.sources), true);

  // Phase 209：组合校验与运行计划只判不跑。
  const composition = {
    id: "nightly",
    name: "夜间巡检",
    steps: [
      { id: "look", skillId: "collector", inputs: { target: "nas" } },
      { id: "report", skillId: "reporter", dependsOn: ["look"] }
    ]
  };
  const validate = await request("/api/compositions/validate", { method: "POST", cookie, body: { composition } });
  assert.equal(validate.status, 200);
  const validateBody = await validate.json();
  assert.equal(Array.isArray(validateBody.report.errors), true);
  const plan = await request("/api/compositions/plan", { method: "POST", cookie, body: { composition, skills: [{ id: "collector", permission: "read-only" }, { id: "reporter", permission: "write" }] } });
  assert.equal(plan.status, 200);
  const planBody = await plan.json();
  assert.equal(Array.isArray(planBody.plan.steps), true);
  const bad = await request("/api/compositions/validate", { method: "POST", cookie, body: { composition: { id: "x", steps: "nope" } } });
  assert.equal(bad.status, 400);

  // Phase 206：触发判定只回结果，非法规则进 notes。
  const triggers = await request("/api/workflows/triggers/evaluate", {
    method: "POST",
    cookie,
    body: {
      rules: [
        { id: "cpu-hot", kind: "threshold", workflowId: "nightly", subject: "cpu", condition: { field: "cpu.percent", operator: "gte", value: 90 } },
        { id: "bad", kind: "nope" }
      ],
      facts: { cpu: { percent: 95 } },
      state: {}
    }
  });
  assert.equal(triggers.status, 200);
  const triggerBody = await triggers.json();
  assert.equal(Array.isArray(triggerBody.fire), true);
  assert.equal(triggerBody.notes.some((note) => note.startsWith("invalid-rule")), true);
  assert.match(triggerBody.note, /不会自动执行/);

  // Phase 208：设备档案能存能读能删，凭据字段被丢掉、序列号只留后 4 位。
  const put = await request("/api/system/device-profiles/nas1", {
    method: "PUT",
    cookie,
    body: {
      id: "nas1",
      hostname: "fnos-nas",
      cpuModel: "J4125",
      cpuCores: 4,
      memoryBytes: 8589934592,
      password: "hunter2",
      disks: [{ name: "sda", sizeBytes: 4000787030016, serial: "PK1386P4HRG3DB" }]
    }
  });
  assert.equal(put.status, 200);
  const putBody = await put.json();
  assert.match(putBody.profile.disks[0].serial, /^\*+G3DB$/, "serial keeps only the last four characters");
  assert.equal(putBody.profile.disks[0].serial.includes("PK1386"), false, "the serial prefix never reaches disk");
  assert.equal(Object.hasOwn(putBody.profile, "password"), false, "credentials are dropped before writing");
  const list = await request("/api/system/device-profiles", { cookie });
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.equal(listBody.profiles.length, 1);
  assert.equal(listBody.profiles[0].freshness.state !== undefined, true);
  const remove = await request("/api/system/device-profiles/nas1", { method: "DELETE", cookie });
  assert.equal(remove.status, 200);
  const gone = await request("/api/system/device-profiles/nas1", { cookie });
  assert.equal(gone.status, 404);

  // 写路由必须过 sameOrigin：没有 Origin 头的 PUT 一律 403。
  const noOrigin = await fetch(`${server.origin}/api/system/device-profiles/nas2`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ id: "nas2" })
  });
  assert.equal(noOrigin.status, 403);
});

test("phase-210: 审计名覆盖新路由", async (t) => {
  const server = await startServer();
  t.after(async () => { await server.stop(); });
  const { cookie, request } = server;
  await request("/api/docker/stats", { cookie });
  await request("/api/diagnostics/log-evidence", { cookie });
  let names = [];
  for (let attempt = 0; attempt < 20 && !names.includes("docker.stats"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const audit = await request("/api/audit?limit=20", { cookie });
    assert.equal(audit.status, 200);
    const body = await audit.json();
    names = (body.events ?? []).map((entry) => entry.route);
  }
  assert.ok(names.includes("docker.stats"), `audit names: ${names.join(",")}`);
  assert.ok(names.includes("diagnostics.log-evidence"), `audit names: ${names.join(",")}`);
});

test("phase-210: Docker 采集器用固定 argv，解析不了的行只留原因与预览", async () => {
  const { createDockerStatsCollector, DOCKER_STATS_COMMAND } = await import("../apps/fnos-nas-agent/app/docker-stats-collector.mjs");
  assert.deepEqual([...DOCKER_STATS_COMMAND.args], ["stats", "--no-stream", "--format", "{{json .}}"]);
  const calls = [];
  const good = JSON.stringify({ Container: "abc", Name: "navidrome", CPUPerc: "1.5%", MemUsage: "120MiB / 8GiB", MemPerc: "1.46%" });
  const collect = createDockerStatsCollector({
    now: () => "2026-01-01T00:00:00.000Z",
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: `${good}\nnot-json\n` };
    }
  });
  const result = await collect();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "docker");
  assert.deepEqual(calls[0].args, ["stats", "--no-stream", "--format", "{{json .}}"]);
  assert.equal(calls[0].options.timeout > 0, true);
  assert.equal(result.collectedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].name, "navidrome");
  assert.equal(result.dropped.length, 1);
  assert.equal(typeof result.dropped[0].reason, "string");
  assert.equal(result.dropped[0].preview.length <= 80, true);
});

test("phase-210: server.mjs 不直接起子进程（架构不变量）", async () => {
  const { readFile } = await import("node:fs/promises");
  const server = await readFile(join(process.cwd(), "apps/fnos-nas-agent/app/server.mjs"), "utf8");
  assert.equal(/from\s+["'](?:node:)?child_process["']/.test(server), false);
});

test("phase-210: 审计白名单覆盖每一个 auditRoute 名字", async () => {
  const { readFile } = await import("node:fs/promises");
  const server = await readFile(join(process.cwd(), "apps/fnos-nas-agent/app/server.mjs"), "utf8");
  const start = server.indexOf("function auditRoute");
  const end = server.indexOf("\n}\n", start);
  const source = server.slice(start, end);
  const names = new Set([...source.matchAll(/"([a-z][a-z0-9]*(?:[.-][a-z0-9]+)+)"/g)].map((match) => match[1]));
  const auditLog = await readFile(join(process.cwd(), "apps/fnos-nas-agent/app/audit-log.mjs"), "utf8");
  const whitelistStart = auditLog.indexOf("const ROUTES = new Set([");
  const whitelistEnd = auditLog.indexOf("]);", whitelistStart);
  const whitelist = new Set([...auditLog.slice(whitelistStart, whitelistEnd).matchAll(/"([a-z][a-z0-9.-]*)"/g)].map((match) => match[1]));
  const missing = [...names].filter((name) => !whitelist.has(name));
  // 白名单外的名字会被静默归一成 other_api，等于丢掉了审计里的路由信息。
  assert.deepEqual(missing, [], `audit-log.mjs 白名单缺少: ${missing.join(",")}`);
});

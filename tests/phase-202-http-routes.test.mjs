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
 * 部署前校验与证书体检都只吃调用方交进来的数据：这两个接口不读宿主、
 * 不连 Docker、不做 TLS 握手。断言要锁住三件事：
 *   1. 未登录一律 401；
 *   2. 校验结论如实反映计划/记录，读不到就 unknown，绝不被说成 ok；
 *   3. 带同一个幂等键重放时返回同一个结果，换了请求体则报冲突。
 */
test("deploy precheck and certificate check routes", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-phase202-"));
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  let output = "";
  const child = spawn(process.execPath, [join(process.cwd(), "apps/fnos-nas-agent/app/server.mjs")], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: String(port), FNOS_AGENT_SERVICE_COLLECTOR: "off" },
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

  assert.equal((await request("/api/deploy/precheck", { method: "POST", body: "{}" })).status, 401);
  assert.equal((await request("/api/network/certificate-check", { method: "POST", body: "{}" })).status, 401);

  const setup = await request("/api/setup", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(setup.status, 201, await setup.text());
  const login = await request("/api/session", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const precheck = (plan, extra = {}) => request("/api/deploy/precheck", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ plan, ...extra })
  });

  const clean = await precheck({ services: [{ name: "worklog", image: "worklog-flask:alpine3", user: "1000:1000", ports: ["8090:8080"], volumes: ["/vol1/1000/worklog:/data:ro"], restart: "always", env: ["TZ=Asia/Shanghai"] }] });
  assert.equal(clean.status, 200);
  const cleanPayload = await clean.json();
  assert.equal(cleanPayload.ok, true);
  assert.equal(cleanPayload.verdict, "ok");
  assert.equal(cleanPayload.serviceCount, 1);

  const blocked = await precheck({ services: [{ name: "evil", image: "alpine", privileged: true, ports: ["80:80"], volumes: ["/vol1:/host"] }] });
  const blockedPayload = await blocked.json();
  assert.equal(blockedPayload.verdict, "blocked");
  assert.equal(blockedPayload.ok, false);
  const codes = blockedPayload.findings.map(finding => finding.code);
  assert.equal(codes.includes("privileged-mode"), true);
  // 端口 80 是特权端口 → review；宿主机卷可写 → review；但 privileged 已经把它压成 blocked。
  assert.equal(codes.includes("privileged-port"), true);
  assert.equal(codes.includes("writable-host-volume"), true);

  const generated = await precheck({ services: [{ name: "x", image: "alpine" }] }, { generate: true });
  assert.equal((await generated.json()).verdict, "blocked");

  const badPlan = await request("/api/deploy/precheck", { method: "POST", headers: { cookie }, body: JSON.stringify({ plan: 42 }) });
  const badPayload = await badPlan.json();
  // 结构非法 → blocked（拒绝）；这仍然是 200，因为问题是被「判定」出来的，不是服务出错。
  assert.equal(badPlan.status, 200);
  assert.equal(badPayload.verdict, "blocked");

  // 幂等：同键同请求 → 直接回放，且不重复判定。
  const key = "precheck-run-1";
  const first = await request("/api/deploy/precheck", {
    method: "POST",
    headers: { cookie, "x-idempotency-key": key },
    body: JSON.stringify({ plan: { services: [{ name: "a", image: "alpine" }] } })
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).replay, undefined);
  const second = await request("/api/deploy/precheck", {
    method: "POST",
    headers: { cookie, "x-idempotency-key": key },
    body: JSON.stringify({ plan: { services: [{ name: "a", image: "alpine" }] } })
  });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).replay, true);

  const conflict = await request("/api/deploy/precheck", {
    method: "POST",
    headers: { cookie, "x-idempotency-key": key },
    body: JSON.stringify({ plan: { services: [{ name: "b", image: "alpine" }] } })
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "idempotency-conflict");

  const invalidKey = await request("/api/deploy/precheck", {
    method: "POST",
    headers: { cookie, "x-idempotency-key": "bad key/with slash" },
    body: JSON.stringify({ plan: { services: [] } })
  });
  assert.equal(invalidKey.status, 400);
  assert.equal((await invalidKey.json()).code, "idempotency-invalid-key");

  const certificates = (payload) => request("/api/network/certificate-check", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify(payload)
  });

  const record = { notBefore: "2026-01-01T00:00:00Z", notAfter: "2027-01-01T00:00:00Z", san: ["dns:nas.example.com"] };
  const good = await certificates({ record, now: "2026-06-01T00:00:00Z", hostname: "nas.example.com" });
  assert.equal(good.status, 200);
  const goodPayload = await good.json();
  assert.equal(goodPayload.verdict, "ok");
  assert.equal(goodPayload.summary.hostnameMatches, true);

  const expiring = await certificates({ record, now: "2026-12-20T00:00:00Z" });
  assert.equal((await expiring.json()).verdict, "expiring");

  const expired = await certificates({ record, now: "2027-02-01T00:00:00Z" });
  assert.equal((await expired.json()).verdict, "expired");

  const mismatch = await certificates({ record, now: "2026-06-01T00:00:00Z", hostname: "evil.example.com" });
  assert.equal((await mismatch.json()).verdict, "invalid");

  const missing = await certificates({ now: "2026-06-01T00:00:00Z" });
  const missingPayload = await missing.json();
  assert.equal(missingPayload.verdict, "unknown");
  assert.equal(missingPayload.record, null);

  const noNow = await certificates({ record });
  assert.equal((await noNow.json()).verdict, "unknown");

  const badWarn = await certificates({ record, now: "2026-06-01T00:00:00Z", warnDays: 0 });
  assert.equal(badWarn.status, 400);
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { APP_VERSION } from "../apps/fnos-nas-agent/app/version.mjs";

const entry = resolve("apps/fnos-nas-agent/app/server.mjs");
const PASSWORD = "CorrectHorseBatteryStaple!";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function waitForHealth(url) {
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(url + "/api/health");
      if (response.ok) return;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error("packaged server did not become healthy");
}

function lanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const item of entries || []) {
      if ((item.family === "IPv4" || item.family === 4) && !item.internal) return item.address;
    }
  }
  return "";
}

async function startServer(t, { env = {}, host = "127.0.0.1" } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-hardening-"));
  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: host,
      AGENT_DATA_DIR: dataDir,
      AGENT_ACCESS_TOKEN: "",
      AGENT_MODEL_ENABLED: "false",
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise(resolveWait => setTimeout(resolveWait, 1500))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl).catch(error => { throw new Error(`${error.message}; ${stderr}`); });
  return { child, dataDir, port, baseUrl, stderr: () => stderr };
}

async function setupAndLogin(baseUrl) {
  const setup = await fetch(baseUrl + "/api/setup", {
    method: "POST",
    headers: { origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD })
  });
  assert.equal(setup.status, 201);
  const login = await fetch(baseUrl + "/api/session", {
    method: "POST",
    headers: { origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD })
  });
  assert.equal(login.status, 200);
  return login.headers.get("set-cookie").split(";")[0];
}

test("the FPK manifest, package metadata and runtime report exactly one version", async () => {
  const manifest = await readFile(resolve("apps/fnos-nas-agent/manifest"), "utf8");
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const manifestVersion = /version\s*=\s*(\S+)/.exec(manifest)?.[1];

  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(manifestVersion, APP_VERSION);
  assert.equal(packageJson.version, APP_VERSION);
});

test("first-run setup requires the installation code for non-loopback callers", async t => {
  const address = lanAddress();
  if (!address) {
    t.skip("no non-loopback IPv4 address is available on this host");
    return;
  }
  const { dataDir, port } = await startServer(t, { host: "0.0.0.0" });
  const lanUrl = `http://${address}:${port}`;

  const state = await (await fetch(lanUrl + "/api/session")).json();
  assert.equal(state.setupRequired, true);
  assert.equal(state.setupCodeRequired, true);

  const withoutCode = await fetch(lanUrl + "/api/setup", {
    method: "POST",
    headers: { origin: lanUrl, "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD })
  });
  assert.equal(withoutCode.status, 403);

  const code = (await readFile(join(dataDir, "setup-code.txt"), "utf8")).trim();
  assert.match(code, /^[a-f0-9]{24}$/);

  const wrongCode = await fetch(lanUrl + "/api/setup", {
    method: "POST",
    headers: { origin: lanUrl, "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD, code: "0".repeat(24) })
  });
  assert.equal(wrongCode.status, 403);

  const withCode = await fetch(lanUrl + "/api/setup", {
    method: "POST",
    headers: { origin: lanUrl, "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD, code })
  });
  assert.equal(withCode.status, 201);
  await assert.rejects(readFile(join(dataDir, "setup-code.txt"), "utf8"));
});

test("global read-only mode refuses write and destructive operations but keeps read-only tools", async t => {
  const { baseUrl } = await startServer(t, { env: { AGENT_EXECUTION_MODE: "read-only" } });
  const cookie = await setupAndLogin(baseUrl);

  const health = await (await fetch(baseUrl + "/api/health")).json();
  assert.equal(health.executionMode, "read-only");
  assert.equal(health.executionModeSource, "environment");

  const catalogue = await (await fetch(baseUrl + "/api/tools", { headers: { cookie } })).json();
  assert.equal(catalogue.executionMode, "read-only");
  assert.equal(catalogue.routineWriteExecutionEnabled, false);

  const write = await fetch(baseUrl + "/api/tools/files.create-folder/run", {
    method: "POST",
    headers: { cookie, origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ path: "/vol1", name: "hardening-test" })
  });
  assert.equal(write.status, 403);
  assert.match((await write.json()).error, /read-only/i);

  const destructive = await fetch(baseUrl + "/api/tools/files.delete/run", {
    method: "POST",
    headers: { cookie, origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ path: "/vol1/never-delete.txt" })
  });
  assert.equal(destructive.status, 403);

  const readOnly = await fetch(baseUrl + "/api/tools/system.status/run", {
    method: "POST",
    headers: { cookie, origin: baseUrl, "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(readOnly.status, 200);
});

test("the kill switch refuses every tool call", async t => {
  const { baseUrl } = await startServer(t, { env: { AGENT_EXECUTION_MODE: "halted" } });
  const cookie = await setupAndLogin(baseUrl);

  const health = await (await fetch(baseUrl + "/api/health")).json();
  assert.equal(health.executionMode, "halted");

  const run = await fetch(baseUrl + "/api/tools/system.status/run", {
    method: "POST",
    headers: { cookie, origin: baseUrl, "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(run.status, 503);
  assert.match((await run.json()).error, /kill switch/i);
});

test("pending approvals are bound to the session that requested them", async t => {
  const { baseUrl } = await startServer(t, {});
  const ownerCookie = await setupAndLogin(baseUrl);
  const otherLogin = await fetch(baseUrl + "/api/session", {
    method: "POST",
    headers: { origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD })
  });
  assert.equal(otherLogin.status, 200);
  const otherCookie = otherLogin.headers.get("set-cookie").split(";")[0];

  const request = await fetch(baseUrl + "/api/tools/files.delete/run", {
    method: "POST",
    headers: { cookie: ownerCookie, origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ path: "/vol1/never-delete.txt" })
  });
  assert.equal(request.status, 202);
  const approval = (await request.json()).approval;

  const ownerPending = await (await fetch(baseUrl + "/api/actions/pending", { headers: { cookie: ownerCookie } })).json();
  assert.equal(ownerPending.actions.length, 1);
  const otherPending = await (await fetch(baseUrl + "/api/actions/pending", { headers: { cookie: otherCookie } })).json();
  assert.equal(otherPending.actions.length, 0);

  const foreignConfirm = await fetch(baseUrl + "/api/actions/" + approval.id + "/confirm", {
    method: "POST",
    headers: { cookie: otherCookie, origin: baseUrl, "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(foreignConfirm.status, 403);
  assert.match((await foreignConfirm.json()).error, /another session/i);

  // The refused attempt must not consume the grant.
  const stillPending = await (await fetch(baseUrl + "/api/actions/pending", { headers: { cookie: ownerCookie } })).json();
  assert.equal(stillPending.actions.length, 1);

  const ownConfirm = await fetch(baseUrl + "/api/actions/" + approval.id + "/confirm", {
    method: "POST",
    headers: { cookie: ownerCookie, origin: baseUrl, "content-type": "application/json" },
    body: "{}"
  });
  const ownBody = await ownConfirm.text();
  // The owning session passes the ownership check. Whether the deletion itself succeeds
  // depends on the target path, so only the ownership verdict is asserted here.
  assert.doesNotMatch(ownBody, /another session/i);
  assert.notEqual(ownConfirm.status, 403);

  const drained = await (await fetch(baseUrl + "/api/actions/pending", { headers: { cookie: ownerCookie } })).json();
  assert.equal(drained.actions.length, 0);
});

test("repeated tool runs are rate limited per session", async t => {
  const { baseUrl } = await startServer(t, {});
  const cookie = await setupAndLogin(baseUrl);

  let limited = null;
  for (let i = 0; i < 40; i++) {
    const response = await fetch(baseUrl + "/api/tools/system.status/run", {
      method: "POST",
      headers: { cookie, origin: baseUrl, "content-type": "application/json" },
      body: "{}"
    });
    if (response.status === 429) {
      limited = response;
      break;
    }
    assert.equal(response.status, 200);
  }
  assert.ok(limited, "the tool run limiter must refuse an unbounded burst");
  assert.match((await limited.json()).error, /too many tool runs/i);
});

test("the operator can engage and lift the kill switch from the console", async t => {
  const { baseUrl } = await startServer(t, {});
  const cookie = await setupAndLogin(baseUrl);

  const initial = await (await fetch(baseUrl + "/api/execution-mode", { headers: { cookie } })).json();
  assert.equal(initial.mode, "normal");
  assert.deepEqual(initial.modes, ["normal", "read-only", "halted"]);

  const anonymous = await fetch(baseUrl + "/api/execution-mode");
  assert.equal(anonymous.status, 401);

  const invalid = await fetch(baseUrl + "/api/execution-mode", {
    method: "POST",
    headers: { cookie, origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ mode: "root" })
  });
  assert.equal(invalid.status, 400);

  const engaged = await fetch(baseUrl + "/api/execution-mode", {
    method: "POST",
    headers: { cookie, origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ mode: "halted" })
  });
  assert.equal(engaged.status, 200);
  assert.equal((await engaged.json()).mode, "halted");

  const haltedHealth = await (await fetch(baseUrl + "/api/health")).json();
  assert.equal(haltedHealth.executionMode, "halted");

  const blocked = await fetch(baseUrl + "/api/tools/system.status/run", {
    method: "POST",
    headers: { cookie, origin: baseUrl, "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(blocked.status, 503);

  // Lifting the kill switch must work while the kill switch is engaged.
  const lifted = await fetch(baseUrl + "/api/execution-mode", {
    method: "POST",
    headers: { cookie, origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ mode: "normal" })
  });
  assert.equal(lifted.status, 200);
  const restored = await (await fetch(baseUrl + "/api/tools/system.status/run", {
    method: "POST",
    headers: { cookie, origin: baseUrl, "content-type": "application/json" },
    body: "{}"
  })).status;
  assert.equal(restored, 200);
});

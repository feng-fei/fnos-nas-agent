import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = path => readFile(join(root, path), "utf8");

const shell = await read("apps/fnos-nas-agent/app/ui/index.html");
const styles = await read("apps/fnos-nas-agent/app/ui/styles.css");
const server = await read("apps/fnos-nas-agent/app/server.mjs");

test("the user interface is a static shell without inline scripts", () => {
  assert.doesNotMatch(shell, /<script(?![^>]*\ssrc=)[^>]*>/, "the shell must not carry an inline script");
  assert.doesNotMatch(shell, /<style[^>]*>/, "the shell must not carry an inline style block");
  assert.match(shell, /<link[^>]+href="\/ui\/styles\.css"/);
  assert.match(shell, /<script src="\/ui\/core\.js"><\/script>/);
  assert.match(shell, /<script src="\/ui\/pages\.js"><\/script>/);
});

test("the shell no longer builds its own navigation at runtime", () => {
  assert.doesNotMatch(shell, /buildWorkspaceLayout/);
  assert.doesNotMatch(shell, /workspace-nav/, "the overflowing legacy navigation bar must be gone");
  assert.match(shell, /class="nav-rail"/);
  assert.match(shell, /class="tabbar"/);
  assert.match(shell, /id="tabbar-more"/);
  assert.match(shell, /id="more-drawer"/);
  assert.match(shell, /class="app-header"/);
  assert.match(shell, /id="page-heading"/);
});

test("the overview page exposes the headline counters", () => {
  for (const id of ["stat-service", "stat-mode", "stat-storage", "stat-tasks", "stat-models", "stat-skills"]) {
    assert.match(shell, new RegExp(`id="${id}"`), `the overview must show #${id}`);
  }
  assert.match(shell, /id="degraded-banner"/);
  assert.match(shell, /id="degraded-list"/);
});

test("the stylesheet provides a mobile first design system", () => {
  assert.match(styles, /@media[^{]*\(min-width:\s*768px\)/, "a tablet breakpoint is required");
  assert.match(styles, /@media[^{]*\(min-width:\s*1120px\)/, "a desktop breakpoint is required");
  assert.match(styles, /@media[^{]*prefers-reduced-motion/);
  assert.match(styles, /@media[^{]*prefers-color-scheme:\s*dark/);
  for (const selector of [".nav-rail", ".tabbar", ".page", ".card", ".stat", ".toast", ".modal"]) {
    assert.ok(styles.includes(selector), `the stylesheet must define ${selector}`);
  }
  assert.match(styles, /\.hidden\s*\{[^}]*display:\s*none/, "the legacy hidden helper must keep working");
  assert.match(styles, /min-height:\s*44px/, "interactive targets must stay reachable with a thumb");
});

test("the server serves the user interface assets from a fixed allow list", () => {
  assert.match(server, /const UI_ASSET_TYPES = new Map\(/);
  assert.match(server, /\["\.css", "text\/css; charset=utf-8"\]/);
  assert.match(server, /\["\.js", "text\/javascript; charset=utf-8"\]/);
  assert.match(server, /if \(!url\.pathname\.startsWith\("\/ui\/"\)\) return false;/);
  assert.match(server, /if \(!\/\^\[A-Za-z0-9\._-\]\+\$\/\.test\(name\)/);
  assert.match(server, /name\.includes\("\.\."\)/);
});

// The HTTP behaviour of the new asset route and the overview endpoint.
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
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(url + "/api/health");
      if (response.ok) return;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error("the server did not become healthy");
}

test("the console serves its assets and the overview snapshot over HTTP", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-console-"));
  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      AGENT_DATA_DIR: dataDir,
      AGENT_ACCESS_TOKEN: "",
      AGENT_MODEL_ENABLED: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise(resolveWait => setTimeout(resolveWait, 1500))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl).catch(error => { throw new Error(`${error.message}; ${stderr}`); });

  const shell = await fetch(baseUrl + "/");
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get("content-type") || "", /text\/html/);
  const shellBody = await shell.text();
  // Since Phase 224 the default console is UI2; the frozen legacy UI stays at /legacy.
  assert.match(shellBody, /<base href="\/next\/">/);
  assert.match(shellBody, /<script type="module" src="\.\/js\/main\.js"><\/script>/);

  const legacy = await fetch(baseUrl + "/legacy");
  assert.equal(legacy.status, 200);
  assert.match(await legacy.text(), /<script src="\/ui\/core\.js"><\/script>/);

  const nextStylesheet = await fetch(baseUrl + "/next/styles.css");
  assert.equal(nextStylesheet.status, 200);
  assert.match(nextStylesheet.headers.get("content-type") || "", /text\/css/);
  const nextScript = await fetch(baseUrl + "/next/js/main.js");
  assert.equal(nextScript.status, 200);
  assert.match(nextScript.headers.get("content-type") || "", /javascript/);
  const nextEscaped = await fetch(baseUrl + "/next/..%2Fserver.mjs");
  assert.equal(nextEscaped.status, 404);

  const stylesheet = await fetch(baseUrl + "/ui/styles.css");
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get("content-type") || "", /text\/css/);

  const script = await fetch(baseUrl + "/ui/core.js");
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") || "", /javascript/);

  const escaped = await fetch(baseUrl + "/ui/..%2Fserver.mjs");
  assert.equal(escaped.status, 404);
  const unknown = await fetch(baseUrl + "/ui/not-a-known-type.txt");
  assert.equal(unknown.status, 404);

  const unauthenticated = await fetch(baseUrl + "/api/overview");
  assert.equal(unauthenticated.status, 401);

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
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(cookie, "the login must hand out a session cookie");

  const overview = await fetch(baseUrl + "/api/overview", { headers: { cookie } });
  assert.equal(overview.status, 200);
  const payload = await overview.json();
  assert.equal(payload.app.name, "fnos-nas-agent");
  assert.ok(payload.execution.modes.includes("halted"));
  assert.equal(typeof payload.tasks.queued, "number");
  assert.equal(typeof payload.approvals.pending, "number");
  assert.doesNotMatch(JSON.stringify(payload), /apiKey|password|token/i);

  const health = await (await fetch(baseUrl + "/api/health")).json();
  assert.equal(payload.app.version, health.version);
});

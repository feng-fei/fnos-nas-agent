import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer as createTcpServer } from "node:net";
import { createDuplicateScanner } from "../apps/fnos-nas-agent/app/duplicate-scan.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");

async function unusedPort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test("duplicate scanner: groups identical content and never groups equal-size different content", async () => {
  const contents = new Map([
    ["/photos/iso-a.jpg", "identical-bytes-0123456789"],
    ["/photos/iso-b.jpg", "identical-bytes-0123456789"],
    ["/photos/unique.jpg", "a-totally-different-payload"],
    ["/photos/same-size-different.jpg", "identical-bytes-012345678X"]
  ]);
  const scanner = createDuplicateScanner({
    listEntries: async () => [...contents.entries()].map(([path, text]) => ({ path, size: Buffer.byteLength(text) })),
    readHash: async (path) => sha(contents.get(path))
  });
  const payload = await scanner.scan({ dir: "/photos", limit: 50 });

  assert.equal(payload.listed, 4);
  assert.equal(payload.groups.length, 1, JSON.stringify(payload.groups));
  const [group] = payload.groups;
  assert.equal(group.paths.length, 2);
  assert.equal(group.size, Buffer.byteLength("identical-bytes-0123456789"));
  assert.equal(group.wastedBytes, group.size);
  assert.deepEqual(group.paths, ["/photos/iso-a.jpg", "/photos/iso-b.jpg"]);
  assert.match(payload.note, /64MiB/);
});

test("duplicate scanner: empty-directory-sized files are ignored and oversized groups are skipped", async () => {
  const scanner = createDuplicateScanner({
    listEntries: async () => ([
      { path: "/d/empty-a", size: 0 },
      { path: "/d/empty-b", size: 0 },
      { path: "/d/big-a", size: 1024 },
      { path: "/d/big-b", size: 1024 },
      { path: "/d/missing-size" },
      { path: "" }
    ]),
    readHash: async () => "unused"
  });
  const payload = await scanner.scan({ dir: "/d", limit: 20, maxHashBytes: 100 });

  assert.equal(payload.listed, 2, "only positive-size entries with a path are analysed");
  assert.equal(payload.groups.length, 0);
  assert.deepEqual(payload.skipped.map(item => item.reason).sort(), ["too-large", "too-large"]);
});

test("duplicate scanner: hash failures degrade to skipped entries", async () => {
  const scanner = createDuplicateScanner({
    listEntries: async () => ([{ path: "/d/a", size: 5 }, { path: "/d/b", size: 5 }]),
    readHash: async (path) => { if (path === "/d/b") throw new Error("EACCES"); return "abc"; }
  });
  const payload = await scanner.scan({ dir: "/d" });
  assert.equal(payload.groups.length, 0);
  assert.equal(payload.skipped.length, 1);
  assert.equal(payload.skipped[0].reason, "hash-failed");
  assert.equal(payload.skipped[0].path, "/d/b");
});

test("duplicate scanner: invalid limit and missing adapters fail loudly", async () => {
  assert.throws(() => createDuplicateScanner({}), /listEntries must be a function/);
  const scanner = createDuplicateScanner({ listEntries: async () => [], readHash: async () => "x" });
  await assert.rejects(() => scanner.scan({ limit: 0 }), (error) => error.statusCode === 400);
  await assert.rejects(() => scanner.scan({ limit: 501 }), (error) => error.statusCode === 400);
  const big = await scanner.scan({ limit: 500 });
  assert.equal(big.groups.length, 0);
});

test("duplicate scan endpoint: session is required and limit is validated before any scan", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-agent-duplicates-data-"));
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

  const anonymous = await request("/api/files/duplicates?path=&limit=20");
  assert.equal(anonymous.status, 401, "duplicate scan must require an Agent session");

  const setup = await request("/api/setup", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(setup.status, 201, await setup.text());
  const login = await request("/api/session", { method: "POST", body: JSON.stringify({ password: "correct-horse-battery" }) });
  assert.equal(login.status, 200, await login.text());
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^nas_agent_session=/);

  assert.equal((await request("/api/files/duplicates?path=&limit=0", { headers: { cookie } })).status, 400);
  assert.equal((await request("/api/files/duplicates?path=&limit=501", { headers: { cookie } })).status, 400);
  assert.equal((await request("/api/files/duplicates?path=&limit=abc", { headers: { cookie } })).status, 400);

  const post = await request("/api/files/duplicates?path=&limit=10", { method: "POST", headers: { cookie }, body: "{}" });
  assert.equal(post.status, 405, "the scan is read-only and must reject writes");
});

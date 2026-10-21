import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const launcher = join(process.cwd(), "apps/fnos-nas-agent/cmd/main");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("FPK start is idempotent and status/stop track the actual bundled runtime process", { skip: process.platform !== "linux" }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "fnos lifecycle smoke "));
  const appRoot = join(workspace, "app root");
  const dataDir = join(workspace, "package var");
  const binDir = join(appRoot, "bin");
  const nodeBin = join(binDir, "node");
  const entry = join(appRoot, "server.mjs");
  const pidFile = join(dataDir, "agent.pid");
  const run = action => spawnSync("bash", [launcher, action], {
    env: { ...process.env, TRIM_APPDEST: appRoot, TRIM_PKGVAR: dataDir, TRIM_SERVICE_PORT: "0", TRIM_TEMP_LOGFILE: join(workspace, "lifecycle-error.log") },
    encoding: "utf8", timeout: 15000
  });
  const liveNodeCommand = async pid => {
    try {
      const args = (await readFile(`/proc/${pid}/cmdline`)).toString("utf8").split(String.fromCharCode(0)).filter(Boolean);
      return args.includes(nodeBin) && args.includes(entry);
    } catch { return false; }
  };
  try {
    await mkdir(binDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await symlink(process.execPath, nodeBin);
    await writeFile(entry, 'import { createServer } from "node:http"; const s=createServer((_q,r)=>r.end("ok")); s.listen(Number(process.env.PORT||"0"),process.env.HOST||"0.0.0.0");', "utf8");
    const started = run("start");
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.equal(await liveNodeCommand(pid), true, "PID must match runtime and entry");
    assert.equal(run("status").status, 0);
    assert.equal(run("start").status, 0);
    assert.equal(Number((await readFile(pidFile, "utf8")).trim()), pid, "start must be idempotent");
    assert.equal(run("stop").status, 0);
    await assert.rejects(readFile(pidFile, "utf8"), error => error.code === "ENOENT");
    for (let i = 0; i < 50 && await liveNodeCommand(pid); i++) await wait(50);
    assert.equal(await liveNodeCommand(pid), false, "stop must terminate the process");
    assert.equal(run("status").status, 3);
  } finally {
    run("stop");
    await rm(workspace, { recursive: true, force: true });
  }
});

test("start fails closed when the bundled Node.js runtime is missing", { skip: process.platform !== "linux" }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "fnos lifecycle missing "));
  const appRoot = join(workspace, "app");
  await mkdir(appRoot, { recursive: true });
  const result = spawnSync("bash", [launcher, "start"], { env: { ...process.env, TRIM_APPDEST: appRoot, TRIM_PKGVAR: join(workspace, "var"), TRIM_TEMP_LOGFILE: join(workspace, "error.log") }, encoding: "utf8", timeout: 5000 });
  try {
    assert.equal(result.status, 1);
    assert.match(await readFile(join(workspace, "error.log"), "utf8"), /Node.js 运行时缺失/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

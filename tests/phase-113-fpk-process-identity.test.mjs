import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const command = join(process.cwd(), "apps/fnos-nas-agent/cmd/main");

test("stale PID that points to an unrelated process is not treated as running or killed", async () => {
  const root = await mkdtemp(join(tmpdir(), "fnos-fpk-pid-identity-"));
  const dataDir = join(root, "data");
  const pidFile = join(dataDir, "agent.pid");
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(pidFile, `${process.pid}\n`, { mode: 0o600 });
    const env = { ...process.env, TRIM_APPDEST: join(root, "app"), TRIM_PKGVAR: dataDir };

    const status = spawnSync("bash", [command, "status"], { env, encoding: "utf8", timeout: 5000 });
    assert.equal(status.status, 3, status.stderr || status.stdout);
    assert.doesNotThrow(() => process.kill(process.pid, 0), "status must not signal this test process");

    const stopped = spawnSync("bash", [command, "stop"], { env, encoding: "utf8", timeout: 5000 });
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
    assert.doesNotThrow(() => process.kill(process.pid, 0), "stop must not signal a PID whose command identity differs");
    await assert.rejects(readFile(pidFile, "utf8"), error => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stop is harmless when TRIM_PKGVAR is absent and never uses a root-level PID path", () => {
  const result = spawnSync("bash", [command, "stop"], {
    env: { ...process.env, TRIM_APPDEST: "/unused/fnos-nas-agent", TRIM_PKGVAR: "" },
    encoding: "utf8",
    timeout: 5000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

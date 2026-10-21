import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const read = path => readFile(join(root, path), "utf8");
const cmdRoot = "apps/fnos-nas-agent/cmd";
const requiredCommands = [
  "main", "install_init", "install_callback", "uninstall_init",
  "uninstall_callback", "upgrade_init", "upgrade_callback",
  "config_init", "config_callback"
];

test("FPK lifecycle command set is complete and every script parses", async () => {
  for (const name of requiredCommands) {
    const path = join(root, cmdRoot, name);
    await access(path);
    const result = spawnSync("bash", ["-n", path], { encoding: "utf8" });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

test("FPK manifest and payload layout agree with the launcher", async () => {
  const [manifest, main, workflow] = await Promise.all([
    read("apps/fnos-nas-agent/manifest"),
    read(join(cmdRoot, "main")),
    read(".github/workflows/build-fpk.yml")
  ]);
  assert.match(manifest, /^appname\s*=\s*fnos-nas-agent$/m);
  assert.match(manifest, /^service_port\s*=\s*18787$/m);
  assert.match(main, /NODE_BIN="\$\{APP_ROOT\}\/bin\/node"/);
  assert.match(main, /ENTRY="\$\{APP_ROOT\}\/server\.mjs"/);
  assert.match(main, /AGENT_DATA_DIR="\$APP_VAR"/);
  assert.match(main, /HOST=0\.0\.0\.0/);
  assert.match(workflow, /node-version:\s*\["26\.x"\]/);
  assert.doesNotMatch(workflow, /- name: Build FPK/);
  assert.doesNotMatch(workflow, /tar -tzf dist\/fnos-nas-agent-test\.fpk/);
});

test("uninstall and upgrade lifecycle scripts preserve user data by default", async () => {
  const [uninstallInit, uninstallCallback, upgradeInit, upgradeCallback] = await Promise.all([
    read(join(cmdRoot, "uninstall_init")),
    read(join(cmdRoot, "uninstall_callback")),
    read(join(cmdRoot, "upgrade_init")),
    read(join(cmdRoot, "upgrade_callback"))
  ]);
  for (const [name, source] of Object.entries({ uninstallInit, uninstallCallback, upgradeInit, upgradeCallback })) {
    assert.doesNotMatch(source, /rm\s+-rf|mkfs|wipefs|dd\s+if=/, `${name} must not contain destructive cleanup`);
  }
  assert.match(uninstallInit, /Preserve app data by default/);
  assert.match(uninstallCallback, /Preserve TRIM_PKGVAR user data by default/);
});

test("install initialization fails closed when the fnOS data path is missing", async () => {
  const source = await read(join(cmdRoot, "install_callback"));
  assert.match(source, /if \[ -z "\$APP_VAR" \]/);
  assert.match(source, /exit 1/);
  assert.doesNotMatch(source, /curl\s|wget\s|apt(-get)?\s+install/);
});

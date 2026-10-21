import test from "node:test";
import assert from "node:assert/strict";
import { createTrimCliAdapter } from "../apps/fnos-nas-agent/app/trim-cli-adapter.mjs";

test("trim-cli adapter refuses to run when no executable is configured", async () => {
  const cli = createTrimCliAdapter({ binaryPath: "", execFileImpl: async () => { throw new Error("must not run"); } });
  assert.deepEqual((await cli.status()).available, false);
  await assert.rejects(cli.runReadOnly("system.info"), { statusCode: 503 });
});

test("trim-cli adapter invokes only fixed argv arrays without a shell", async () => {
  let call;
  const cli = createTrimCliAdapter({
    binaryPath: "/opt/trim-cli",
    accessImpl: async () => {},
    profile: "home",
    execFileImpl: async (...args) => { call = args; return { stdout: '{"ok":true}', stderr: "" }; }
  });
  assert.deepEqual(await cli.runReadOnly("file.ls", { path: "/vol1/photos" }), {
    command: "file.ls", data: { ok: true }
  });
  assert.equal(call[0], "/opt/trim-cli");
  assert.deepEqual(call[1], ["--profile", "home", "file", "ls", "/vol1/photos"]);
  assert.equal(call[2].shell, undefined);
  assert.equal(call[2].timeout, 15000);
});

test("trim-cli adapter keeps OAuth profile storage under the private app data directory", async () => {
  let call;
  const cli = createTrimCliAdapter({
    binaryPath: "/opt/trim-cli",
    env: { PATH: "/usr/bin:/bin", AGENT_DATA_DIR: "/private/fnos-agent-data" },
    accessImpl: async () => {},
    execFileImpl: async (...args) => { call = args; return { stdout: "{}" }; }
  });
  await cli.runReadOnly("system.info");
  assert.equal(call[2].env.HOME, "/private/fnos-agent-data");
  assert.equal(call[2].env.XDG_CONFIG_HOME, "/private/fnos-agent-data/.config");
  assert.equal(call[2].env.AGENT_MODEL_API_KEY, undefined);
});

test("trim-cli adapter rejects arbitrary commands and invalid arguments before execution", async () => {
  let calls = 0;
  const cli = createTrimCliAdapter({ binaryPath: "/opt/trim-cli", accessImpl: async () => {}, execFileImpl: async () => { calls++; return { stdout: "{}" }; } });
  await assert.rejects(cli.runReadOnly("raw", { path: "/etc" }), { statusCode: 404 });
  await assert.rejects(cli.runReadOnly("file.ls", { path: " /vol1" }), { statusCode: 400 });
  await assert.rejects(cli.runReadOnly("file.ls", { path: "/etc" }), { statusCode: 400 });
  await assert.rejects(cli.runReadOnly("file.ls", { path: "/vol1", extra: "x" }), { statusCode: 400 });
  await assert.rejects(cli.runReadOnly("file.ls", { path: "/vol1/../etc" }), { statusCode: 400 });
  await assert.rejects(cli.runReadOnly("file.ls", { path: "/vol1/./secret" }), { statusCode: 400 });
  await assert.rejects(cli.runReadOnly("file.ls", { path: "/vol1\\\\..\\\\etc" }), { statusCode: 400 });
  await assert.rejects(cli.runReadOnly("file.ls", { path: "/vol1\\n/etc" }), { statusCode: 400 });
  await assert.rejects(cli.runReadOnly("file.usage", { volumeId: 0 }), { statusCode: 400 });
  assert.equal(calls, 0);
});

test("trim-cli adapter suppresses stderr and bounds timeout failures", async () => {
  const cli = createTrimCliAdapter({
    binaryPath: "/opt/trim-cli",
    accessImpl: async () => {},
    execFileImpl: async () => { const error = new Error("secret token leaked in stderr"); error.stderr = "refresh_token=secret"; error.code = "ETIMEDOUT"; throw error; }
  });
  await assert.rejects(cli.runReadOnly("system.info"), error => {
    assert.equal(error.statusCode, 504);
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
});

test("trim-cli adapter exposes verified read-only photo and capability commands", async () => {
  const calls = [];
  const cli = createTrimCliAdapter({
    binaryPath: "/opt/trim-cli",
    accessImpl: async () => {},
    execFileImpl: async (...args) => { calls.push(args); return { stdout: '{"items":[]}', stderr: "" }; }
  });
  assert.deepEqual(await cli.runReadOnly("photos.folders"), { command: "photos.folders", data: { items: [] } });
  assert.deepEqual(await cli.runReadOnly("monitor.beep-supported"), { command: "monitor.beep-supported", data: { items: [] } });
  assert.deepEqual(await cli.runReadOnly("photos.search", { keyword: "family album" }), { command: "photos.search", data: { items: [] } });
  assert.deepEqual(calls.map(call => call[1].slice(2)), [
    ["photos", "folders"],
    ["monitor", "beep-supported"],
    ["photos", "search", "family album", "--limit", "20"]
  ]);
  await assert.rejects(cli.runReadOnly("photos.search", { keyword: "   " }), { statusCode: 400 });
  await assert.rejects(cli.runReadOnly("photos.search", { keyword: "cats", limit: 51 }), { statusCode: 400 });
  await assert.rejects(cli.runReadOnly("photos.search", { keyword: "cats", extra: true }), { statusCode: 400 });
  assert.equal(calls.length, 3);
});

test("trim-cli profile and timeout configuration are validated", () => {
  assert.throws(() => createTrimCliAdapter({ profile: "../other" }), /profile/);
  assert.throws(() => createTrimCliAdapter({ timeoutMs: 1 }), /timeout/);
});

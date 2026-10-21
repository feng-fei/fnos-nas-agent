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

test("trim-cli adapter rejects arbitrary commands and invalid arguments before execution", async () => {
  let calls = 0;
  const cli = createTrimCliAdapter({ binaryPath: "/opt/trim-cli", execFileImpl: async () => { calls++; return { stdout: "{}" }; } });
  await assert.rejects(cli.runReadOnly("raw", { path: "/etc" }), { statusCode: 404 });
  await assert.rejects(cli.runReadOnly("file.ls", { path: " /vol1" }), { statusCode: 400 });
  await assert.rejects(cli.runReadOnly("file.ls", { path: "/vol1", extra: "x" }), { statusCode: 400 });
  await assert.rejects(cli.runReadOnly("file.usage", { volumeId: 0 }), { statusCode: 400 });
  assert.equal(calls, 0);
});

test("trim-cli adapter suppresses stderr and bounds timeout failures", async () => {
  const cli = createTrimCliAdapter({
    binaryPath: "/opt/trim-cli",
    execFileImpl: async () => { const error = new Error("secret token leaked in stderr"); error.stderr = "refresh_token=secret"; error.code = "ETIMEDOUT"; throw error; }
  });
  await assert.rejects(cli.runReadOnly("system.info"), error => {
    assert.equal(error.statusCode, 504);
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
});

test("trim-cli profile and timeout configuration are validated", () => {
  assert.throws(() => createTrimCliAdapter({ profile: "../other" }), /profile/);
  assert.throws(() => createTrimCliAdapter({ timeoutMs: 1 }), /timeout/);
});

// Phase 226 — 确认式命令执行（system.command）的不变量。
// 全部用注入的 execFileImpl，从不执行真实命令。

import test from "node:test";
import assert from "node:assert/strict";
import { createCommandExecSource } from "../apps/fnos-nas-agent/app/command-exec.mjs";
import { DELETE_CAPABILITY } from "../apps/fnos-nas-agent/app/execution-capability.mjs";
import { createAgentCore } from "../apps/fnos-nas-agent/app/agent-core.mjs";

const CAP = DELETE_CAPABILITY;

function fakeExec(impl) {
  const calls = [];
  const fn = async (file, args, options) => {
    calls.push({ file, args, options });
    return impl(file, args, options);
  };
  fn.calls = calls;
  return fn;
}

const okExec = fakeExec(async () => ({ stdout: "hello\n", stderr: "" }));

test("the source publishes system.command (destructive) and the read-only pre-check", () => {
  const src = createCommandExecSource({ execFileImpl: okExec, dataDir: "/tmp" });
  const tools = src.list();
  const main = tools.find(t => t.id === "system.command");
  const check = tools.find(t => t.id === "system.command-check");
  assert.equal(main.risk, "destructive");
  assert.equal(check.risk, "read-only");
  assert.equal(main.inputSchema.properties.command.maxLength, 2000);
});

test("invoke without the server capability is refused before anything runs", async () => {
  const exec = fakeExec(async () => { throw new Error("must not run"); });
  const src = createCommandExecSource({ execFileImpl: exec, dataDir: "/tmp" });
  await assert.rejects(src.invoke("system.command", { command: "df -h" }, {}),
    /one-time approval/);
  await assert.rejects(src.invoke("system.command", { command: "df -h" }, { capability: "forged" }),
    /one-time approval/);
  assert.equal(exec.calls.length, 0);
});

test("a block-severity command is refused by the scanner and never executed", async () => {
  const exec = fakeExec(async () => ({ stdout: "", stderr: "" }));
  const src = createCommandExecSource({ execFileImpl: exec, dataDir: "/tmp" });
  await assert.rejects(
    src.invoke("system.command", { command: "rm -rf /vol1" }, { capability: CAP }),
    /安全扫描拦截/);
  assert.equal(exec.calls.length, 0);
});

test("a clean read-only command runs via bash -c with a minimal environment", async () => {
  const exec = fakeExec(async () => ({ stdout: "hello\n", stderr: "" }));
  const src = createCommandExecSource({ execFileImpl: exec, dataDir: "/data", timeoutMs: 5000 });
  const r = await src.invoke("system.command", { command: "echo hello" }, { capability: CAP });
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, "hello\n");
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].file, "/bin/bash");
  assert.deepEqual(exec.calls[0].args, ["-c", "echo hello"]);
  assert.equal(exec.calls[0].options.timeout, 5000);
  assert.equal(exec.calls[0].options.env.HOME, "/data");
  assert.ok(!("SUDO_USER" in exec.calls[0].options.env));
  assert.ok(Object.keys(exec.calls[0].options.env).length <= 4);
});

test("a non-zero exit is a structured result, not an exception", async () => {
  const error = new Error("exit 2");
  error.code = 2; error.stdout = "partial"; error.stderr = "boom";
  const src = createCommandExecSource({ execFileImpl: fakeExec(async () => { throw error; }), dataDir: "/tmp" });
  const r = await src.invoke("system.command", { command: "false" }, { capability: CAP });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 2);
  assert.equal(r.stderr, "boom");
});

test("a killed (timeout) run reports timedOut instead of leaking", async () => {
  const error = new Error("killed"); error.killed = true; error.signal = "SIGTERM";
  const src = createCommandExecSource({ execFileImpl: fakeExec(async () => { throw error; }), dataDir: "/tmp" });
  const r = await src.invoke("system.command", { command: "sleep 999" }, { capability: CAP });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
});

test("oversized stdout is truncated", async () => {
  const src = createCommandExecSource({
    execFileImpl: fakeExec(async () => ({ stdout: "x".repeat(40 * 1024), stderr: "" })), dataDir: "/tmp"
  });
  const r = await src.invoke("system.command", { command: "cat big" }, { capability: CAP });
  assert.ok(r.stdout.length < 40 * 1024);
  assert.match(r.stdout, /输出已截断/);
});

test("the pre-check tool classifies without executing", async () => {
  const exec = fakeExec(async () => { throw new Error("must not run"); });
  const src = createCommandExecSource({ execFileImpl: exec, dataDir: "/tmp" });
  const blocked = await src.invoke("system.command-check", { command: "rm -rf /vol1" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.check.verdict, "block");
  const clean = await src.invoke("system.command-check", { command: "df -h" });
  assert.equal(clean.ok, true);
  assert.equal(exec.calls.length, 0);
});

test("agent-core routes 运行命令：… to a single destructive proposal (approval, not execution)", async () => {
  const exec = fakeExec(async () => { throw new Error("must not run"); });
  const src = createCommandExecSource({ execFileImpl: exec, dataDir: "/tmp" });
  const sourceTools = { list: () => src.list(), invoke: (id, args, options) => src.invoke(id, args, options) };
  let requested = null;
  const core = createAgentCore({
    tools: sourceTools,
    model: { plan: async () => null, status: () => ({ enabled: false }) },
    requestApproval: async action => { requested = action; return { id: "ap-1" }; }
  });
  const outcome = await core.run({ text: "运行命令：df -h" });
  assert.equal(outcome.status, "awaiting-approval");
  assert.equal(requested.toolId, "system.command");
  assert.equal(requested.args.command, "df -h");
  assert.equal(exec.calls.length, 0);
});

test("agent-core surfaces the scanner refusal message for blocked proposals", async () => {
  const exec = fakeExec(async () => { throw new Error("must not run"); });
  const src = createCommandExecSource({ execFileImpl: exec, dataDir: "/tmp" });
  const core = createAgentCore({
    tools: { list: () => src.list(), invoke: (id, args, options) => src.invoke(id, args, options) },
    model: { plan: async () => null, status: () => ({ enabled: false }) },
    requestApproval: async action => { throw Object.assign(new Error("命令被安全扫描拦截，未创建确认请求：block: 删除"), { statusCode: 403, code: "COMMAND_BLOCKED" }); }
  });
  const outcome = await core.run({ text: "运行命令：rm -rf /vol1" });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.message, /命令被安全扫描拦截/);
  assert.equal(exec.calls.length, 0);
});

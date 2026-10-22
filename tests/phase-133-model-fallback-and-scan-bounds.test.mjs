import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, lstat, realpath, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelAdapter } from "../apps/fnos-nas-agent/app/model-adapter.mjs";
import { createFileBrowser } from "../apps/fnos-nas-agent/app/file-browser.mjs";
import { createPermissionPolicy } from "../apps/fnos-nas-agent/app/permission-policy.mjs";

const enabledConfig = overrides => ({
  enabled: true,
  endpoint: "https://model.example/v1/chat/completions",
  apiKey: "test-secret-key",
  model: "test-model",
  timeoutMs: 1000,
  ...overrides
});
const envelope = content => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
const tools = [{ id: "system.status", title: "系统状态", description: "只读状态", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];

const primary = { ...enabledConfig(), providerId: "aaaaaaaaaaaaaaaaaaaaaaaa", providerName: "Primary" };
const backup = {
  enabled: true, endpoint: "https://backup.example/v1/chat/completions", apiKey: "backup-secret",
  model: "backup-model", providerId: "bbbbbbbbbbbbbbbbbbbbbbbb", providerName: "Backup", timeoutMs: 1000
};

function adapterWith(status, calls) {
  return createModelAdapter({
    configProvider: () => primary,
    fallbackConfigProvider: () => [backup],
    sleepImpl: async () => {},
    fetchImpl: async url => {
      calls.push(url);
      if (url === primary.endpoint) return new Response("provider refused", { status });
      return envelope({ message: "backup works", toolCalls: [] });
    }
  });
}

test("a provider that refuses the request still lets the configured backup provider answer", async () => {
  const calls = [];
  const adapter = adapterWith(401, calls);
  const plan = await adapter.plan("hello", tools);
  assert.deepEqual(plan, { message: "backup works", toolCalls: [] });
  assert.deepEqual(calls, [primary.endpoint, backup.endpoint]);
});

test("a provider that does not know the model still lets the configured backup provider answer", async () => {
  const calls = [];
  const adapter = adapterWith(404, calls);
  const plan = await adapter.plan("hello", tools);
  assert.deepEqual(plan, { message: "backup works", toolCalls: [] });
  assert.deepEqual(calls, [primary.endpoint, backup.endpoint]);
});

test("a malformed request is not repeated against the backup provider", async () => {
  const calls = [];
  const adapter = adapterWith(400, calls);
  await assert.rejects(adapter.plan("hello", tools), error => error.code === "MODEL_PROVIDER_ERROR");
  assert.deepEqual(calls, [primary.endpoint]);
});

test("the upstream status survives the adapter so the caller can explain the failure", async () => {
  const adapter = createModelAdapter({
    configProvider: () => primary,
    sleepImpl: async () => {},
    fetchImpl: async () => new Response("unauthorized", { status: 401 })
  });
  await assert.rejects(adapter.plan("hello", tools), error => error.statusCode === 401);
});

test("the permission policy delegates its verdict to the global execution policy", async () => {
  const source = await readFile(new URL("../apps/fnos-nas-agent/app/permission-policy.mjs", import.meta.url), "utf8");
  assert.match(source, /import \{ createExecutionPolicy \} from "\.\/execution-policy\.mjs"/);
  assert.match(source, /executionPolicy\.evaluate\(/);
  // The legacy shape and reason vocabulary stay valid for the existing callers.
  const policy = createPermissionPolicy();
  assert.deepEqual(policy.evaluate({ risk: "read-only" }), { allowed: true, requiresApproval: false, reason: "read-only-allowed" });
  assert.deepEqual(policy.evaluate({ risk: "write" }), { allowed: true, requiresApproval: false, reason: "write-allowed" });
  assert.deepEqual(policy.evaluate({ risk: "destructive" }), { allowed: false, requiresApproval: true, reason: "explicit-approval-required" });
  assert.equal(policy.evaluate({ risk: "destructive", approved: true }).allowed, true);
  assert.equal(policy.evaluate({ risk: "shell" }).allowed, false);
  assert.equal(policy.snapshot().executionEnabled, false);
});

test("the file browser stops after a bounded number of entries and reports the truncation", async t => {
  if (process.platform !== "linux") {
    t.skip("the directory descriptor confinement only runs on Linux");
    return;
  }
  const temp = await mkdtemp(join(tmpdir(), "fnos-browser-bounded-"));
  try {
    const root = join(temp, "vol1");
    await mkdir(root);
    const synthetic = Array.from({ length: 2500 }, (_, index) => ({
      name: "file-" + index,
      isSymbolicLink: () => false,
      isDirectory: () => false,
      isFile: () => true
    }));
    const fs = {
      readdir: async path => {
        if (typeof path === "string" && path.startsWith("/proc/self/fd/")) return synthetic;
        return [];
      },
      lstat: async path => {
        if (typeof path === "string" && path.startsWith("/proc/self/fd/")) {
          return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: 1, mtime: new Date(0) };
        }
        return lstat(path);
      },
      realpath,
      open
    };
    const browser = createFileBrowser({ roots: [root], fs });
    const result = await browser.list(root, 5);
    assert.equal(result.truncated, true);
    assert.equal(result.entries.length, 5);
    assert.ok(result.totalDirectoryEntries <= 2000);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

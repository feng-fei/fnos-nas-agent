import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileManager } from "../apps/fnos-nas-agent/app/file-manager.mjs";
import { createReadOnlyToolRegistry } from "../apps/fnos-nas-agent/app/read-only-tools.mjs";
import { DELETE_CAPABILITY, hasDeleteCapability } from "../apps/fnos-nas-agent/app/execution-capability.mjs";
import { createExecutionPolicy } from "../apps/fnos-nas-agent/app/execution-policy.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "fnos-delete-capability-"));
  const file = join(directory, "victim.txt");
  await writeFile(file, "victim", "utf8");
  return { directory, file, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function registry({ executionPolicy = null } = {}) {
  const calls = [];
  return {
    calls,
    registry: createReadOnlyToolRegistry({
      getDiagnostics: async () => ({ collectedAt: new Date().toISOString() }),
      fileBrowser: { list: async () => ["entry"], search: async () => [] },
      fileManager: {
        operate: async input => { calls.push(input); return { action: input.action, path: input.path ?? null }; }
      },
      executionPolicy
    })
  };
}

test("the delete capability is a module-private symbol that no client can construct", () => {
  assert.equal(hasDeleteCapability(DELETE_CAPABILITY), true);
  assert.equal(hasDeleteCapability(Symbol.for("fnos-nas-agent.delete-capability")), false);
  assert.equal(hasDeleteCapability("fnos-nas-agent.delete-capability"), false);
  assert.equal(hasDeleteCapability({ capability: DELETE_CAPABILITY }), false);
  assert.equal(hasDeleteCapability(undefined), false);
});

test("the file manager refuses a delete that carries no server capability", async () => {
  const { directory, file, cleanup } = await fixture();
  try {
    const manager = createFileManager({ roots: [directory] });
    await assert.rejects(manager.operate({ action: "delete", path: file }), error => {
      assert.equal(error.statusCode, 403);
      assert.match(error.message, /Explicit confirmation is required/);
      return true;
    });
  } finally {
    await cleanup();
  }
});

test("a client supplied confirm boolean is not an authorization", async () => {
  const { directory, file, cleanup } = await fixture();
  try {
    const manager = createFileManager({ roots: [directory] });
    await assert.rejects(manager.operate({ action: "delete", path: file, confirm: true }), error => {
      assert.equal(error.statusCode, 403);
      assert.match(error.message, /Explicit confirmation is required/);
      return true;
    });
    await assert.rejects(manager.operate({ action: "delete", path: file, capability: "delete" }), error => {
      assert.equal(error.statusCode, 403);
      return true;
    });
  } finally {
    await cleanup();
  }
});

test("the file manager accepts a delete that carries the real capability", async () => {
  const { directory, file, cleanup } = await fixture();
  try {
    const manager = createFileManager({ roots: [directory] });
    if (process.platform === "linux") {
      // Linux runs the real delete: the capability authorises it, the descriptor
      // confinement still applies.
      const result = await manager.operate({ action: "delete", path: file, capability: DELETE_CAPABILITY });
      assert.equal(result.deleted, true);
    } else {
      // Other platforms refuse the directory-descriptor confinement step (503).
      // The authorization layer already accepted the capability, so the failure is
      // the platform guard, not the authorization.
      await assert.rejects(manager.operate({ action: "delete", path: file, capability: DELETE_CAPABILITY }), error => {
        assert.equal(error.statusCode, 503);
        return true;
      });
    }
  } finally {
    await cleanup();
  }
});

test("a batch that contains an unauthorized delete is refused as a whole", async () => {
  const { directory, file, cleanup } = await fixture();
  try {
    const manager = createFileManager({ roots: [directory] });
    await assert.rejects(manager.operateBatch({
      operations: [
        { action: "mkdir", path: directory, name: "sub" },
        { action: "delete", path: file }
      ]
    }), error => {
      assert.equal(error.statusCode, 403);
      assert.match(error.message, /Explicit confirmation is required/);
      return true;
    });
  } finally {
    await cleanup();
  }
});

test("the tool registry refuses files.delete without the capability", async () => {
  const { registry: tools } = registry();
  await assert.rejects(tools.invoke("files.delete", { path: "/vol1/archive.txt" }), error => {
    assert.equal(error.statusCode, 403);
    return true;
  });
});

test("the tool registry forwards the capability for an approved delete", async () => {
  const { registry: tools, calls } = registry();
  const result = await tools.invoke("files.delete", { path: "/vol1/archive.txt" }, { capability: DELETE_CAPABILITY });
  assert.equal(result.action, "delete");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].capability, DELETE_CAPABILITY);
  assert.equal(calls[0].confirm, undefined);
});

test("read-only mode refuses write tools and keeps read-only tools working", async () => {
  const policy = createExecutionPolicy({ env: { AGENT_EXECUTION_MODE: "read-only" } });
  const { registry: tools } = registry({ executionPolicy: policy });
  await assert.rejects(tools.invoke("files.create-folder", { path: "/vol1", name: "new" }), error => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.reason, "read-only-mode");
    return true;
  });
  await assert.rejects(tools.invoke("files.rename", { path: "/vol1/a", name: "b" }), error => {
    assert.equal(error.statusCode, 403);
    return true;
  });
  assert.deepEqual(await tools.invoke("files.list", {}), ["entry"]);
});

test("read-only mode refuses a destructive call even when a capability is presented", async () => {
  const policy = createExecutionPolicy({ env: { AGENT_EXECUTION_MODE: "read-only" } });
  const { registry: tools, calls } = registry({ executionPolicy: policy });
  await assert.rejects(tools.invoke("files.delete", { path: "/vol1/a" }, { capability: DELETE_CAPABILITY }), error => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.reason, "read-only-mode");
    return true;
  });
  assert.equal(calls.length, 0);
});

test("halted mode blocks every tool call with 503", async () => {
  const policy = createExecutionPolicy({ env: { AGENT_EXECUTION_MODE: "halted" } });
  const { registry: tools, calls } = registry({ executionPolicy: policy });
  await assert.rejects(tools.invoke("files.list", {}), error => {
    assert.equal(error.statusCode, 503);
    assert.equal(error.reason, "kill-switch");
    return true;
  });
  await assert.rejects(tools.invoke("files.create-folder", { path: "/vol1", name: "new" }), error => {
    assert.equal(error.statusCode, 503);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("normal mode still runs write tools and requires an approval for destructive ones", async () => {
  const policy = createExecutionPolicy({ env: {} });
  const { registry: tools, calls } = registry({ executionPolicy: policy });
  await tools.invoke("files.create-folder", { path: "/vol1", name: "new" });
  assert.equal(calls.length, 1);
  await assert.rejects(tools.invoke("files.delete", { path: "/vol1/a" }), error => {
    assert.equal(error.statusCode, 403);
    return true;
  });
  assert.equal(calls.length, 1);
});

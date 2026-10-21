import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileManager } from "../apps/fnos-nas-agent/app/file-manager.mjs";
import { createReadOnlyToolRegistry } from "../apps/fnos-nas-agent/app/read-only-tools.mjs";
import { createAgentCore } from "../apps/fnos-nas-agent/app/agent-core.mjs";

async function fixture(fn) {
  const temp = await mkdtemp(join(tmpdir(), "fnos-write-tools-"));
  const root = join(temp, "vol1");
  await mkdir(root);
  try { await fn({ root }); } finally { await rm(temp, { recursive: true, force: true }); }
}
function model() {
  return { status: () => ({ enabled: false }), plan: async () => { throw new Error("model must not be called"); } };
}

test("routine file write tools are registered as writes with closed schemas", async () => fixture(async ({ root }) => {
  const manager = createFileManager({ roots: [root] });
  const registry = createReadOnlyToolRegistry({ getDiagnostics: async () => ({}), fileManager: manager });
  const tools = registry.list();
  for (const id of ["files.create-folder", "files.rename", "files.move"]) {
    const tool = tools.find(item => item.id === id);
    assert.equal(tool.risk, "write");
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
}));

test("registered routine file write tools create, rename and move without confirmation", async () => fixture(async ({ root }) => {
  const manager = createFileManager({ roots: [root] });
  const registry = createReadOnlyToolRegistry({ getDiagnostics: async () => ({}), fileManager: manager });
  const created = await registry.invoke("files.create-folder", { path: root, name: "docs" });
  assert.equal((await stat(created.path)).isDirectory(), true);
  const source = join(root, "draft.txt");
  await writeFile(source, "hello");
  const renamed = await registry.invoke("files.rename", { path: source, name: "final.txt" });
  assert.equal(await readFile(renamed.path, "utf8"), "hello");
  const moved = await registry.invoke("files.move", { path: renamed.path, destination: join(root, "docs") });
  assert.equal(moved.path, join(root, "docs", "final.txt"));
  assert.equal(await readFile(moved.path, "utf8"), "hello");
}));

test("routine file write tools retain storage-root and no-overwrite protections", async () => fixture(async ({ root }) => {
  const manager = createFileManager({ roots: [root] });
  const registry = createReadOnlyToolRegistry({ getDiagnostics: async () => ({}), fileManager: manager });
  await registry.invoke("files.create-folder", { path: root, name: "docs" });
  await assert.rejects(registry.invoke("files.create-folder", { path: root, name: "docs" }), error => error.statusCode === 409);
  await assert.rejects(registry.invoke("files.create-folder", { path: root + "/../", name: "escape" }), error => error.statusCode === 403 || error.statusCode === 404);
  await assert.rejects(registry.invoke("files.move", { path: root, destination: root }), error => error.statusCode === 403);
  await assert.rejects(registry.invoke("files.rename", { path: root + "/missing", name: "x" }), error => error.statusCode === 404);
}));

test("rules-first Agent executes explicit routine file write intents without model calls", async () => fixture(async ({ root }) => {
  const manager = createFileManager({ roots: [root] });
  const registry = createReadOnlyToolRegistry({ getDiagnostics: async () => ({}), fileManager: manager });
  const agent = createAgentCore({ tools: registry, model: model(), id: () => "task-write-0001" });
  const created = await agent.run({ text: `创建文件夹 项目资料 于 ${root}` });
  assert.equal(created.status, "completed");
  assert.equal(created.results[0].tool, "files.create-folder");
  const file = join(root, "before.txt");
  await writeFile(file, "data");
  const renamed = await agent.run({ text: `重命名 ${file} 为 after.txt` });
  assert.equal(renamed.results[0].tool, "files.rename");
  const moved = await agent.run({ text: `移动 ${join(root, "after.txt")} 到 ${root}/项目资料` });
  assert.equal(moved.results[0].tool, "files.move");
  assert.equal(await readFile(join(root, "项目资料", "after.txt"), "utf8"), "data");
}));

test("Agent upload tool is a bounded routine write and refuses overwrite",async()=>fixture(async({root})=>{const manager=createFileManager({roots:[root]});const registry=createReadOnlyToolRegistry({getDiagnostics:async()=>({}),fileManager:manager});const tool=registry.list().find(x=>x.id==="files.upload");assert.equal(tool.risk,"write");const payload=Buffer.from("binary\\0payload","utf8");const result=await registry.invoke("files.upload",{path:root,name:"upload.bin",contentBase64:payload.toString("base64")});assert.deepEqual(await readFile(result.path),payload);await assert.rejects(registry.invoke("files.upload",{path:root,name:"upload.bin",contentBase64:payload.toString("base64")}),e=>e.statusCode===409);await assert.rejects(registry.invoke("files.upload",{path:root,name:"bad.bin",contentBase64:"%%"}),e=>e.statusCode===400);await assert.rejects(registry.invoke("files.upload",{path:root,name:"large.bin",contentBase64:Buffer.alloc(1024*1024+1).toString("base64")}),e=>e.statusCode===400||e.statusCode===413);}));

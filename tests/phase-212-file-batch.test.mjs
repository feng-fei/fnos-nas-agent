import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFileManager } from "../apps/fnos-nas-agent/app/file-manager.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "apps", "fnos-nas-agent", "app");

async function tempVolume() {
  const base = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(base, "phase212-"));
  return dir;
}

// 安全文件操作依赖 Linux 目录描述符（O_PATH）。Windows 上会稳定地拒绝，
// 所以这里分两条路：Linux 跑真实批次，Windows 断言「拒绝」本身也是逐项结果。
const linux = process.platform === "linux";

test("batch rename and move keep every item inside the root", { skip: !linux }, async () => {
  const dir = await tempVolume();
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "a");
    await fs.writeFile(path.join(dir, "b.txt"), "b");
    await fs.mkdir(path.join(dir, "done"));
    const manager = createFileManager({ roots: [dir] });
    const result = await manager.operateBatch({
      operations: [
        { action: "rename", path: path.join(dir, "a.txt"), name: "2026-a.txt" },
        { action: "move", path: path.join(dir, "b.txt"), destination: path.join(dir, "done") }
      ]
    });
    assert.equal(result.total, 2);
    assert.equal(result.succeeded, 2);
    assert.equal(result.failed, 0);
    assert.deepEqual((await fs.readdir(dir)).sort(), ["2026-a.txt", "done"]);
    assert.deepEqual(await fs.readdir(path.join(dir, "done")), ["b.txt"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a batch reports per-item failures instead of aborting the rest", { skip: !linux }, async () => {
  const dir = await tempVolume();
  try {
    await fs.writeFile(path.join(dir, "keep.txt"), "keep");
    const manager = createFileManager({ roots: [dir] });
    const result = await manager.operateBatch({
      operations: [
        { action: "mkdir", path: dir, name: "made-by-batch" },
        { action: "rename", path: path.join(dir, "missing.txt"), name: "nope.txt" },
        { action: "mkdir", path: dir, name: "made-by-batch" }
      ]
    });
    assert.equal(result.total, 3);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 2);
    assert.equal(result.results[0].ok, true);
    assert.equal(result.results[1].ok, false);
    assert.equal(result.results[2].ok, false);
    assert.equal(result.results.filter((item) => item.ok === false).every((item) => typeof item.error === "string"), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a refused batch still reports one result per operation", { skip: linux }, async () => {
  const dir = await tempVolume();
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "a");
    const manager = createFileManager({ roots: [dir] });
    const result = await manager.operateBatch({
      operations: [
        { action: "rename", path: path.join(dir, "a.txt"), name: "2026-a.txt" },
        { action: "mkdir", path: dir, name: "sub" }
      ]
    });
    // 非 Linux 上没有目录描述符，单项只能拒绝；关键是批次结构仍然完整。
    assert.equal(result.total, 2);
    assert.equal(result.succeeded + result.failed, 2);
    assert.equal(result.results.length, 2);
    assert.equal(result.results.every((item) => item.ok === false), true);
    assert.equal(result.results.every((item) => item.statusCode === 503), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a batch refuses more than twenty operations and deletes without capability", async () => {
  const dir = await tempVolume();
  try {
    const manager = createFileManager({ roots: [dir] });
    const tooMany = Array.from({ length: 21 }, (_, index) => ({ action: "mkdir", path: dir, name: "d" + index }));
    await assert.rejects(() => manager.operateBatch({ operations: tooMany }), (error) => error.statusCode === 400);
    await assert.rejects(
      () => manager.operateBatch({ operations: [{ action: "delete", path: dir }] }),
      (error) => error.statusCode === 403
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the files page exposes multi-select batch controls", async () => {
  const html = await fs.readFile(path.join(appDir, "ui", "index.html"), "utf8");
  const pages = await fs.readFile(path.join(appDir, "ui", "pages.js"), "utf8");
  for (const id of ["file-batch-bar", "file-batch-count", "file-batch-clear", "file-batch-select-page", "file-batch-prefix", "file-batch-rename", "file-batch-target", "file-batch-move", "file-batch-result"]) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
  assert.match(pages, /const fileBatchSelection=new Map\(\)/, "必须维护选择态");
  assert.match(pages, /const FILE_BATCH_LIMIT=20/, "上限必须与服务端 operateBatch 的 20 项一致");
  assert.match(pages, /api\("\/api\/files\/operations\/batch"/, "必须走批量接口");
  assert.match(pages, /async function runFileBatch\(operations\)/, "批量执行必须是一个独立函数");
  assert.match(pages, /function fileBatchRename\(\)/, "批量重命名必须存在");
  assert.match(pages, /function fileBatchMove\(\)/, "批量移动必须存在");
  assert.match(pages, /document\.querySelector\("#file-batch-clear"\)\.addEventListener/, "清空选择必须绑定");
  assert.match(pages, /document\.querySelector\("#file-batch-move"\)\.addEventListener/, "批量移动必须绑定");
});

test("batch results are rendered without building markup from strings", async () => {
  const pages = await fs.readFile(path.join(appDir, "ui", "pages.js"), "utf8");
  const start = pages.indexOf("function renderFileBatchResult(payload)");
  const end = pages.indexOf("async function runFileBatch(operations)");
  assert.ok(start > 0 && end > start, "renderFileBatchResult 必须是独立函数");
  const snippet = pages.slice(start, end);
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML/.test(snippet), false, "批量结果必须用 textContent 渲染");
  assert.match(snippet, /payload\.succeeded/, "结果必须包含成功计数");
  assert.match(snippet, /failure\.reason/, "结果必须带服务端给出的拒绝原因");
});

test("selection is pruned when the directory changes", async () => {
  const pages = await fs.readFile(path.join(appDir, "ui", "pages.js"), "utf8");
  assert.match(pages, /for\(const selectedPath of \[\.\.\.fileBatchSelection\.keys\(\)\]\)if\(!present\.has\(selectedPath\)\)fileBatchSelection\.delete\(selectedPath\)/, "刷新目录时必须清掉已不存在的选择");
});

test("the batch UI never offers deletion", async () => {
  const pages = await fs.readFile(path.join(appDir, "ui", "pages.js"), "utf8");
  const start = pages.indexOf("function fileBatchRename()");
  const end = pages.indexOf("async function refreshFiles(");
  const snippet = pages.slice(start, end);
  assert.equal(snippet.includes('action:"delete"'), false, "批量区不得提供删除（删除必须逐项确认）");
});

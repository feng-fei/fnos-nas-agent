import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, rename, rm, readFile, readdir, lstat, realpath, open, link, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFileManager } from "../apps/fnos-nas-agent/app/file-manager.mjs";

const baseFs = { readdir, lstat, realpath, mkdir, open, link, unlink, rename, rmdir, readFile };

async function fixture({ racePath = false } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "fnos-file-read-fd-"));
  const root = join(workspace, "allowed");
  const target = join(root, "data.txt");
  const backup = target + ".original";
  const outside = join(workspace, "outside.txt");
  await mkdir(root);
  await writeFile(target, "inside volume", "utf8");
  await writeFile(outside, "outside secret", "utf8");

  let armed = racePath;
  const fs = {
    ...baseFs,
    lstat: async (path, ...args) => {
      const info = await lstat(path, ...args);
      if (armed && resolve(path) === target) {
        armed = false;
        await rename(target, backup);
        await symlink(outside, target);
      }
      return info;
    }
  };
  return {
    target,
    manager: createFileManager({ roots: [root], fs }),
    cleanup: () => rm(workspace, { recursive: true, force: true })
  };
}

test("preview, checksum, and download use the opened file descriptor", async () => {
  const { manager, target, cleanup } = await fixture();
  try {
    const preview = await manager.preview(target);
    assert.equal(preview.content, "inside volume");

    const checksum = await manager.checksum(target);
    assert.equal(checksum.sha256, createHash("sha256").update("inside volume").digest("hex"));

    const downloaded = await manager.download(target);
    try {
      assert.equal(await downloaded.handle.readFile("utf8"), "inside volume");
      assert.equal(downloaded.sizeBytes, Buffer.byteLength("inside volume"));
    } finally {
      await downloaded.handle.close();
    }
  } finally {
    await cleanup();
  }
});

for (const operation of ["preview", "checksum", "download"]) {
  test(operation + " rejects a path swapped to an outside symlink after validation", async () => {
    const { manager, target, cleanup } = await fixture({ racePath: true });
    try {
      await assert.rejects(manager[operation](target), error => error?.statusCode === 409);
    } finally {
      await cleanup();
    }
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, lstat, realpath, open, link, unlink, rename, rmdir, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFileManager } from "../apps/fnos-nas-agent/app/file-manager.mjs";

const baseFs = { mkdtemp, mkdir, writeFile, readFile, lstat, realpath, open, link, unlink, rename, rmdir, readdir };

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function fixture({ race = "none" } = {}) {
  const temp = await mkdtemp(join(tmpdir(), "fnos-file-write-fd-"));
  const root = join(temp, "allowed");
  const directory = join(root, "items");
  const moved = join(root, "items.moved");
  const outside = join(temp, "outside");
  await mkdir(directory, { recursive: true });
  await mkdir(outside);
  await writeFile(join(directory, "source.txt"), "source");
  await writeFile(join(outside, "secret.txt"), "outside secret");
  let armed = race !== "none";
  const fs = {
    ...baseFs,
    async lstat(path, ...args) {
      const info = await lstat(path, ...args);
      if (race === "before-open" && armed && resolve(path) === directory) {
        armed = false;
        await rename(directory, moved);
        await symlink(outside, directory);
      }
      return info;
    },
    async open(path, flags, ...args) {
      const handle = await open(path, flags, ...args);
      if (race === "after-open" && armed && typeof flags === "number" && resolve(path) === directory) {
        armed = false;
        await rename(directory, moved);
        await symlink(outside, directory);
      }
      return handle;
    }
  };
  return {
    root, directory, moved, outside,
    manager: createFileManager({ roots: [root], fs }),
    async cleanup() { await rm(temp, { recursive: true, force: true }); }
  };
}

async function perform(manager, directory, action) {
  switch (action) {
    case "upload": return manager.upload(directory, "new-upload.txt", Buffer.from("uploaded"));
    case "createText": return manager.createText(directory, "new-text.txt", "created text");
    case "mkdir": return manager.operate({ action: "mkdir", path: directory, name: "new-folder" });
    case "rename": return manager.operate({ action: "rename", path: join(directory, "source.txt"), name: "renamed.txt" });
    case "delete": return manager.operate({ action: "delete", path: join(directory, "source.txt"), confirm: true });
    default: throw new Error("Unknown test action");
  }
}

for (const action of ["upload", "createText", "mkdir", "rename", "delete"]) {
  test(action + " fails closed when its target directory is swapped to an outside symlink before open", async () => {
    const f = await fixture({ race: "before-open" });
    try {
      await assert.rejects(perform(f.manager, f.directory, action), error => [403, 409].includes(error?.statusCode));
      assert.equal(await readFile(join(f.outside, "secret.txt"), "utf8"), "outside secret");
      assert.equal(await exists(join(f.outside, "new-upload.txt")), false);
      assert.equal(await exists(join(f.outside, "new-text.txt")), false);
      assert.equal(await exists(join(f.outside, "new-folder")), false);
      assert.equal(await readFile(join(f.moved, "source.txt"), "utf8"), "source");
    } finally { await f.cleanup(); }
  });

  test(action + " does not redirect a mutation outside the root when the path changes after open", async () => {
    const f = await fixture({ race: "after-open" });
    try {
      await assert.rejects(perform(f.manager, f.directory, action), error => error?.statusCode === 409);
      assert.equal(await readFile(join(f.outside, "secret.txt"), "utf8"), "outside secret");
      assert.equal(await exists(join(f.outside, "new-upload.txt")), false);
      assert.equal(await exists(join(f.outside, "new-text.txt")), false);
      assert.equal(await exists(join(f.outside, "new-folder")), false);
      assert.equal(await exists(join(f.moved, "new-upload.txt")), false);
      assert.equal(await exists(join(f.moved, "new-text.txt")), false);
      assert.equal(await exists(join(f.moved, "new-folder")), false);
      assert.equal(await readFile(join(f.moved, "source.txt"), "utf8"), "source");
    } finally { await f.cleanup(); }
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rename, rm, readdir, lstat, realpath, open, link, unlink, rmdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFileManager } from "../apps/fnos-nas-agent/app/file-manager.mjs";

const baseFs = { readdir, lstat, realpath, mkdir, open, link, unlink, rename, rmdir, readFile };

async function fixture(raceTarget) {
  const workspace = await mkdtemp(join(tmpdir(), "fnos-file-mutation-fd-"));
  const root = join(workspace, "allowed");
  const parent = join(root, "sub");
  const movedParent = join(root, "sub-original");
  const destination = join(root, "destination");
  const outside = join(workspace, "outside");
  const source = join(parent, "source.txt");
  await mkdir(parent, { recursive: true });
  await mkdir(destination);
  await mkdir(outside);
  await writeFile(source, "inside data");
  await writeFile(join(outside, "source.txt"), "outside data");
  let armed = true;
  const fs = {
    ...baseFs,
    async lstat(path, ...args) {
      const info = await lstat(path, ...args);
      if (armed && resolve(path) === raceTarget({ parent, source })) {
        armed = false;
        await rename(parent, movedParent);
        await symlink(outside, parent);
      }
      return info;
    }
  };
  return {
    workspace, root, parent, movedParent, destination, outside, source,
    manager: createFileManager({ roots: [root], fs }),
    async cleanup() { await rm(workspace, { recursive: true, force: true }); }
  };
}


for (const mode of ["create-text", "upload", "mkdir"]) {
  test(mode + " refuses a parent directory swapped to an outside symlink", async () => {
    const f = await fixture(({ parent }) => parent);
    try {
      if (mode === "create-text") await assert.rejects(f.manager.createText(f.parent, "new.txt", "safe"), error => [403, 409].includes(error?.statusCode));
      else if (mode === "upload") await assert.rejects(f.manager.upload(f.parent, "new.txt", Buffer.from("safe")), error => [403, 409].includes(error?.statusCode));
      else await assert.rejects(f.manager.operate({ action: "mkdir", path: f.parent, name: "new-dir" }), error => [403, 409].includes(error?.statusCode));
      assert.equal(await readFile(join(f.outside, "source.txt"), "utf8"), "outside data");
      assert.deepEqual(await readdir(f.outside), ["source.txt"]);
      assert.ok(await readdir(f.movedParent));
    } finally { await f.cleanup(); }
  });
}

for (const mode of ["delete", "rename", "move"]) {
  test(mode + " refuses to act through a replaced source parent", async () => {
    const f = await fixture(({ source }) => source);
    try {
      const request = mode === "delete"
        ? { action: "delete", path: f.source, confirm: true }
        : mode === "rename"
          ? { action: "rename", path: f.source, name: "renamed.txt" }
          : { action: "move", path: f.source, destination: f.destination };
      await assert.rejects(f.manager.operate(request), error => [403, 409].includes(error?.statusCode));
      assert.equal(await readFile(join(f.outside, "source.txt"), "utf8"), "outside data");
      assert.equal(await readFile(join(f.movedParent, "source.txt"), "utf8"), "inside data");
      assert.deepEqual(await readdir(f.outside), ["source.txt"]);
      assert.deepEqual(await readdir(f.destination), []);
    } finally { await f.cleanup(); }
  });
}

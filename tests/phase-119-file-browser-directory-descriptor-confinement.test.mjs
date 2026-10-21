import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rename, rm, readdir, lstat, realpath, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFileBrowser } from "../apps/fnos-nas-agent/app/file-browser.mjs";

const baseFs = { readdir, lstat, realpath, open };

async function fixture({ race = "none" } = {}) {
  const temp = await mkdtemp(join(tmpdir(), "fnos-browser-fd-"));
  const root = join(temp, "allowed");
  const moved = root + ".moved";
  const outside = join(temp, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, "inside.txt"), "inside");
  await writeFile(join(outside, "secret.txt"), "outside");
  let armed = race !== "none";
  let rootLstatCalls = 0;
  const fs = {
    ...baseFs,
    async lstat(path, ...args) {
      const info = await lstat(path, ...args);
      if (race === "before-open" && armed && resolve(path) === root && ++rootLstatCalls >= 2) {
        armed = false;
        await rename(root, moved);
        await symlink(outside, root);
      }
      return info;
    },
    async readdir(path, ...args) {
      if (race === "after-open" && armed && typeof path === "string" && path.startsWith("/proc/self/fd/")) {
        armed = false;
        await rename(root, moved);
        await symlink(outside, root);
      }
      return readdir(path, ...args);
    }
  };
  return {
    temp, root, moved, outside,
    browser: createFileBrowser({ roots: [root], fs }),
    async cleanup() { await rm(temp, { recursive: true, force: true }); }
  };
}

test("directory path swapped to an outside symlink before open fails closed", async () => {
  const f = await fixture({ race: "before-open" });
  try {
    await assert.rejects(f.browser.list(f.root), error => error?.statusCode === 409);
    // A new browser operation recomputes roots, so restore a fresh tree for this assertion.
  } finally {
    await f.cleanup();
  }
  const g = await fixture({ race: "before-open" });
  try {
    await assert.rejects(g.browser.search(g.root, "secret"), error => error?.statusCode === 409);
  } finally {
    await g.cleanup();
  }
});

test("listing and recursive search remain anchored to the opened directory after path replacement", async () => {
  const f = await fixture({ race: "after-open" });
  try {
    const listed = await f.browser.list(f.root);
    assert.deepEqual(listed.entries.map(entry => entry.name), ["inside.txt"]);
  } finally {
    await f.cleanup();
  }

  const g = await fixture({ race: "after-open" });
  try {
    const searched = await g.browser.search(g.root, "secret");
    assert.deepEqual(searched.entries, []);
  } finally {
    await g.cleanup();
  }
});

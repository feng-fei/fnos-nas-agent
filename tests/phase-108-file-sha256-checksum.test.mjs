import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFile as readText } from "node:fs/promises";
import { createFileManager, MAX_CHECKSUM_BYTES } from "../apps/fnos-nas-agent/app/file-manager.mjs";
import { readUiSource } from "./helpers/ui-source.mjs";

test("checksum returns the expected SHA-256 using the bounded streaming file API", async t => {
  const root = await mkdtemp(join(tmpdir(), "fnos-checksum-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "hello.txt");
  const content = Buffer.from("hello world\n", "utf8");
  await writeFile(filePath, content);
  const manager = createFileManager({ roots: [root] });
  const result = await manager.checksum(filePath);
  assert.equal(result.name, "hello.txt");
  assert.equal(result.path, filePath);
  assert.equal(result.sizeBytes, content.length);
  assert.equal(result.algorithm, "SHA-256");
  assert.equal(result.sha256, createHash("sha256").update(content).digest("hex"));
  assert.equal(result.sha256, "a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447");

  const emptyPath = join(root, "empty");
  await writeFile(emptyPath, Buffer.alloc(0));
  assert.equal((await manager.checksum(emptyPath)).sha256,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("checksum refuses non-files, paths outside configured roots, symlinks and over-limit files", async t => {
  const root = await mkdtemp(join(tmpdir(), "fnos-checksum-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "fnos-checksum-outside-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const directory = join(root, "folder");
  const external = join(outside, "private.txt");
  await mkdir(directory);
  await writeFile(external, "outside");
  await symlink(external, join(root, "link.txt"));
  const bigPath = join(root, "too-large.bin");
  const bigHandle = await open(bigPath, "w");
  await bigHandle.truncate(MAX_CHECKSUM_BYTES + 1);
  await bigHandle.close();
  const manager = createFileManager({ roots: [root] });
  await assert.rejects(manager.checksum(directory), { statusCode: 400 });
  await assert.rejects(manager.checksum(external), { statusCode: 403 });
  await assert.rejects(manager.checksum(join(root, "link.txt")), { statusCode: 403 });
  await assert.rejects(manager.checksum(bigPath), { statusCode: 413 });
});

test("checksum rejects a file that changes during the calculation", async t => {
  const root = await mkdtemp(join(tmpdir(), "fnos-checksum-change-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "change.txt");
  await writeFile(filePath, "initial-content");
  const promises = await import("node:fs/promises");
  let statCalls = 0;
  const fs = {
    ...promises,
    open: async (path, flags) => {
      const handle = await promises.open(path, flags);
      return {
        read: handle.read.bind(handle),
        close: handle.close.bind(handle),
        stat: async options => {
          statCalls++;
          if (statCalls === 2) await writeFile(filePath, "content-changed-after-open");
          return handle.stat(options);
        }
      };
    }
  };
  const manager = createFileManager({ roots: [root], fs });
  await assert.rejects(manager.checksum(filePath), { statusCode: 409 });
});

test("checksum API requires authentication, rate-limits per session, and the mobile UI displays only returned digest text", async () => {
  const server = await readText(new URL("../apps/fnos-nas-agent/app/server.mjs", import.meta.url), "utf8");
  const html = await readUiSource();
  const start = server.indexOf('if (url.pathname === "/api/files/checksum")');
  const end = server.indexOf('if (url.pathname === "/api/files/preview")', start);
  assert.ok(start >= 0 && end > start, "checksum route must be registered before preview/download routes");
  const route = server.slice(start, end);
  assert.match(route, /sessionFor\(req\)/);
  assert.match(route, /fileChecksumLimiter\.allow\(activeSession\.key\)/);
  assert.match(route, /fileManager\.checksum\(/);
  assert.match(route, /File checksum is limited to 5 requests per minute/);
  assert.match(server, /pathname === "\/api\/files\/checksum".*files\.checksum/);
  assert.match(html, /actionButton\("计算 SHA-256"/);
  assert.match(html, /api\("\/api\/files\/checksum\?path="/);
  assert.match(html, /SHA-256："\+result\.sha256/);
  assert.doesNotMatch(html, /result\.sha256\.toUpperCase\(\).*innerHTML/);
});

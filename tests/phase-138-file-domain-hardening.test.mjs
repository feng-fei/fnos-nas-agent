import test from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileBrowser,
  compareRootPaths,
  summarizeDirectoryEntries,
  foldName,
  directoryVersion,
  isTemporaryEntryName,
  OFFSET_DRIFT_HINT
} from "../apps/fnos-nas-agent/app/file-browser.mjs";
import {
  createFileManager,
  publishStagedFile,
  moveEntryWithoutOverwrite,
  restoreMovedEntry,
  nativeErrorStatus,
  decodePreviewBuffer,
  TEMP_FILE_PREFIX
} from "../apps/fnos-nas-agent/app/file-manager.mjs";
import { createReadOnlyToolRegistry, decodeUploadPayload } from "../apps/fnos-nas-agent/app/read-only-tools.mjs";
import { createTrimCliAdapter } from "../apps/fnos-nas-agent/app/trim-cli-adapter.mjs";
import { DELETE_CAPABILITY } from "../apps/fnos-nas-agent/app/execution-capability.mjs";

// The file browser and the file manager normally pin every directory through
// a Linux directory descriptor (/proc/self/fd). The tests inject the resolver
// seam instead, so the listing, the search and the write operations can be
// verified on every platform. The seam returns the real directory path, which
// is what the descriptor path would resolve to on Linux.
//
// The Windows file index of a directory can change between two handles, so the
// dev/ino identity check of the file manager is not stable on this platform.
// The seam therefore keeps the identity of the last lstat stable. The
// descriptor hardening itself is covered by the Linux only tests.
function testFs(overrides = {}) {
  const identities = new Map();
  const asBigInt = value => (typeof value === "bigint" ? value : BigInt(value));
  const stableOpen = async (path, flags, mode) => {
    const handle = await fsp.open(path, flags, mode);
    handle.__path = String(path);
    const realStat = handle.stat.bind(handle);
    handle.stat = async options => {
      const info = await realStat(options);
      if (!options || !options.bigint) return info;
      let known = identities.get(String(path));
      if (!known) {
        const resolved = await fsp.realpath(path).catch(() => "");
        known = identities.get(resolved);
      }
      if (!known) return info;
      const patched = Object.create(Object.getPrototypeOf(info));
      Object.assign(patched, info, { dev: asBigInt(known.dev), ino: asBigInt(known.ino) });
      return patched;
    };
    return handle;
  };
  const fs = {
    ...fsp,
    ...overrides,
    lstat: async (path, options) => {
      const info = await fsp.lstat(path, options);
      identities.set(String(path), { dev: info.dev, ino: info.ino });
      return info;
    },
    open: overrides.open || stableOpen
  };
  return { fs, descriptorPathFor: handle => handle.__path, stableOpen };
}

async function makeTempRoot(t, prefix) {
  const temp = await fsp.mkdtemp(join(tmpdir(), prefix));
  t.after(async () => { await fsp.rm(temp, { recursive: true, force: true }); });
  const root = join(temp, "vol1");
  await fsp.mkdir(root);
  return { temp, root: await fsp.realpath(root) };
}

function entry(name, directoryPath, { isDirectory = false } = {}) {
  return {
    name,
    path: join(directoryPath, name),
    type: isDirectory ? "directory" : "file",
    sizeBytes: isDirectory ? null : 1,
    modifiedAt: new Date(0).toISOString(),
    isDirectory
  };
}

test("the files.list tool forwards the offset, the sort mode, the name query and the type filter", async () => {
  const seen = [];
  const browser = { list: async (...args) => { seen.push(args); return { entries: [], totalEntries: 0 }; } };
  const registry = createReadOnlyToolRegistry({ getDiagnostics: async () => ({}), fileBrowser: browser });
  const schema = registry.list().find(tool => tool.id === "files.list").inputSchema;
  assert.ok(schema.properties.offset, "the schema has to advertise the offset");
  assert.ok(schema.properties.sort, "the schema has to advertise the sort mode");
  assert.ok(schema.properties.query, "the schema has to advertise the name query");
  assert.ok(schema.properties.type, "the schema has to advertise the type filter");
  assert.equal(schema.additionalProperties, false);
  await registry.invoke("files.list", { path: "/vol1", limit: 2, offset: 4, sort: "name-asc", query: "log", type: "file" });
  assert.deepEqual(seen[0], ["/vol1", 2, 4, "name-asc", "log", "file"], "the browser arguments keep the browser order");
  await registry.invoke("files.list", { path: "/vol1" });
  assert.deepEqual(seen[1], ["/vol1", 100, 0, "directories-first", "", "all"], "the defaults keep the old behaviour");
  // An unknown property is still refused, the new fields do not open the door.
  await assert.rejects(registry.invoke("files.list", { path: "/vol1", cursor: 4 }), error => error.statusCode === 400);
  // An unknown sort mode or type filter is refused before the call.
  await assert.rejects(registry.invoke("files.list", { path: "/vol1", sort: "by-vibes" }), error => error.statusCode === 400);
  await assert.rejects(registry.invoke("files.list", { path: "/vol1", type: "symlink" }), error => error.statusCode === 400);
  await assert.rejects(registry.invoke("files.list", { path: "/vol1", limit: 201 }), error => error.statusCode === 400);
});

test("a move never replaces an existing target and leaves the source in place", async t => {
  const { root } = await makeTempRoot(t, "fnos-phase-138-move-");
  const source = join(root, "source.txt");
  const target = join(root, "target.txt");
  await fsp.writeFile(source, "source content");
  await fsp.writeFile(target, "target content");
  await assert.rejects(
    moveEntryWithoutOverwrite({ fs: fsp, sourcePath: source, targetPath: target, sourceIsDirectory: false }),
    error => error.statusCode === 409
  );
  assert.equal(await fsp.readFile(target, "utf8"), "target content", "the existing target is untouched");
  assert.equal(await fsp.readFile(source, "utf8"), "source content", "the source is still in place");
});

test("the file manager renames a file without leaving a copy behind and refuses an occupied target", async t => {
  const { root } = await makeTempRoot(t, "fnos-phase-138-rename-");
  const { fs, descriptorPathFor } = testFs();
  const manager = createFileManager({ roots: [root], fs, descriptorPathFor });
  await fsp.writeFile(join(root, "a.txt"), "a");
  await fsp.writeFile(join(root, "b.txt"), "b");
  await assert.rejects(
    manager.operate({ action: "rename", path: join(root, "a.txt"), name: "b.txt" }),
    error => error.statusCode === 409
  );
  assert.equal(await fsp.readFile(join(root, "b.txt"), "utf8"), "b", "the occupied target is untouched");
  assert.equal(await fsp.readFile(join(root, "a.txt"), "utf8"), "a", "the refused source is untouched");
  const renamed = await manager.operate({ action: "rename", path: join(root, "a.txt"), name: "c.txt" });
  assert.equal(renamed.name, "c.txt");
  assert.equal(await fsp.readFile(join(root, "c.txt"), "utf8"), "a");
  await assert.rejects(fsp.lstat(join(root, "a.txt")), error => error.code === "ENOENT", "the old name is released");
});

test("an upload that runs out of space answers 507 instead of 500", async t => {
  const { root } = await makeTempRoot(t, "fnos-phase-138-enospc-");
  const { fs, descriptorPathFor, stableOpen } = testFs();
  fs.open = async (path, flags, mode) => {
    if (String(path).includes(TEMP_FILE_PREFIX)) {
      const error = new Error("no space left on device");
      error.code = "ENOSPC";
      throw error;
    }
    return stableOpen(path, flags, mode);
  };
  const manager = createFileManager({ roots: [root], fs, descriptorPathFor });
  await assert.rejects(manager.upload(root, "a.bin", Buffer.from("hello")), error => error.statusCode === 507);
  await assert.rejects(manager.createText(root, "a.txt", "hello"), error => error.statusCode === 507);
  // The native error codes are mapped to the status codes a client can act on.
  assert.equal(nativeErrorStatus({ code: "ENOSPC" }).statusCode, 507);
  assert.equal(nativeErrorStatus({ code: "EDQUOT" }).statusCode, 507);
  assert.equal(nativeErrorStatus({ code: "EACCES" }).statusCode, 403);
  assert.equal(nativeErrorStatus({ code: "EPERM" }).statusCode, 403);
  assert.equal(nativeErrorStatus({ code: "ENOENT" }).statusCode, 404);
  assert.equal(nativeErrorStatus({ code: "EIO" }), null, "an unknown native code is not mapped");
});

test("a write leaves no staged file behind and removes the stale staged files of the directory", async t => {
  const { root } = await makeTempRoot(t, "fnos-phase-138-staged-");
  const stale = join(root, TEMP_FILE_PREFIX + "stale.tmp");
  await fsp.writeFile(stale, "leftover of a crashed write");
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fsp.utimes(stale, old, old);
  const { fs, descriptorPathFor } = testFs();
  const manager = createFileManager({ roots: [root], fs, descriptorPathFor });
  await manager.createText(root, "note.txt", "hello");
  const names = await fsp.readdir(root);
  assert.deepEqual(names.filter(name => name.startsWith(TEMP_FILE_PREFIX)), [], "the stale staged file is removed");
  assert.deepEqual(names.filter(name => name.startsWith(".fnos-text-") || name.startsWith(".fnos-upload-")), [], "no staged file of an older scheme is left behind");
  assert.ok(names.includes("note.txt"));
});

test("the listing hides the staged write files and reports the symbolic links it skipped", async t => {
  const { root } = await makeTempRoot(t, "fnos-phase-138-listing-");
  await fsp.writeFile(join(root, "visible.txt"), "x");
  await fsp.writeFile(join(root, TEMP_FILE_PREFIX + "staged.tmp"), "x");
  await fsp.symlink(join(root, "visible.txt"), join(root, "link.txt"), "file");
  const { fs, descriptorPathFor } = testFs();
  const browser = createFileBrowser({ roots: [root], fs, descriptorPathFor });
  const result = await browser.list(root);
  assert.deepEqual(result.entries.map(item => item.name), ["visible.txt"], "neither the staged file nor the link is listed");
  assert.equal(result.skippedSymbolicLinks, 1, "the skipped link is counted");
  assert.equal(result.totalDirectoryEntries, 1);
  assert.equal(result.totalEntries, 1);
  assert.equal(isTemporaryEntryName(TEMP_FILE_PREFIX + "x.tmp"), true);
  assert.equal(isTemporaryEntryName("visible.txt"), false);
});

test("a single oversized directory does not stop the search in the other directories", async t => {
  const { root } = await makeTempRoot(t, "fnos-phase-138-search-");
  await fsp.mkdir(join(root, "huge"));
  await fsp.mkdir(join(root, "other"));
  const scanner = async (directoryPath) => {
    if (directoryPath === root) {
      return { entries: [entry("huge", root, { isDirectory: true }), entry("other", root, { isDirectory: true })], read: 2, truncated: false };
    }
    if (directoryPath === join(root, "huge")) {
      // The directory holds more entries than the scan budget allows.
      return { entries: [entry("huge-one.txt", directoryPath)], read: 1, truncated: true };
    }
    if (directoryPath === join(root, "other")) {
      return { entries: [entry("needle.txt", directoryPath)], read: 1, truncated: false };
    }
    return { entries: [], read: 0, truncated: false };
  };
  const browser = createFileBrowser({ roots: [root], scanDirectory: scanner });
  const result = await browser.search(root, "needle", 10);
  assert.equal(result.partialDirectories, 1, "the oversized directory is counted");
  assert.equal(result.incomplete, true, "the answer is incomplete");
  assert.equal(result.stopped, false, "the traversal did not stop early");
  assert.equal(result.truncated, false, "the result list itself was not cut off");
  assert.deepEqual(result.entries.map(item => item.name), ["needle.txt"], "the other directories are still searched");
});

test("the search and the listing fold the case without the machine locale", async t => {
  const { root } = await makeTempRoot(t, "fnos-phase-138-case-");
  await fsp.writeFile(join(root, "Report.TXT"), "x");
  await fsp.writeFile(join(root, "notes.txt"), "x");
  const { fs, descriptorPathFor } = testFs();
  const browser = createFileBrowser({ roots: [root], fs, descriptorPathFor });
  const listed = await browser.list(root, 10, 0, "name-asc", "report");
  assert.deepEqual(listed.entries.map(item => item.name), ["Report.TXT"], "the query matches regardless of the case");
  const searched = await browser.search(root, "REPORT", 10);
  assert.deepEqual(searched.entries.map(item => item.name), ["Report.TXT"], "the search matches regardless of the case");
  // The folding is pinned: a Turkish locale would fold "I" to a dotless i.
  assert.equal(foldName("I"), "i");
  assert.notEqual(foldName("İ"), "i", "the dotted capital I keeps its dot");
  assert.equal(foldName("ÄÖÜ"), "äöü");
});

test("the listing reports a directory version that changes with the content", async t => {
  const { root } = await makeTempRoot(t, "fnos-phase-138-version-");
  await fsp.writeFile(join(root, "a.txt"), "x");
  const { fs, descriptorPathFor } = testFs();
  const browser = createFileBrowser({ roots: [root], fs, descriptorPathFor });
  const before = await browser.list(root);
  await fsp.writeFile(join(root, "b.txt"), "y");
  const after = await browser.list(root);
  assert.equal(before.directoryVersion.length, 16);
  assert.notEqual(before.directoryVersion, after.directoryVersion, "the version detects the drift between two pages");
  assert.equal(before.driftHint, OFFSET_DRIFT_HINT, "the client is told how to detect the drift");
  assert.equal(directoryVersion([entry("a.txt", root)]), directoryVersion([entry("a.txt", root)]));
});

test("the preview decodes a UTF-16 document, refuses a binary file and reports the path", async t => {
  const { root } = await makeTempRoot(t, "fnos-phase-138-preview-");
  const textFile = join(root, "utf16.txt");
  await fsp.writeFile(textFile, Buffer.from("\uFEFFhello world", "utf16le"));
  const { fs, descriptorPathFor } = testFs();
  const manager = createFileManager({ roots: [root], fs, descriptorPathFor });
  const result = await manager.preview(textFile);
  assert.equal(result.content, "hello world", "a UTF-16 document is decoded instead of refused");
  assert.equal(result.path, await fsp.realpath(textFile), "the preview reports the path of the file");
  assert.equal(result.name, "utf16.txt");
  assert.equal(result.sizeBytes, 24);
  // A binary file is still refused.
  await fsp.writeFile(join(root, "binary.bin"), Buffer.from([1, 0, 2]));
  await assert.rejects(manager.preview(join(root, "binary.bin")), error => error.statusCode === 415);
  // The pure helper agrees with the file manager. Node has no big endian
  // encoding for Buffer, so the byte order mark is built by hand.
  const littleEndian = Buffer.from("\uFEFFhi", "utf16le");
  const bigEndian = Buffer.from([littleEndian[1], littleEndian[0], littleEndian[3], littleEndian[2], littleEndian[5], littleEndian[4]]);
  assert.equal(decodePreviewBuffer(bigEndian), "hi");
});

test("a symbolic link is deleted as a link and its target survives", async t => {
  const { root } = await makeTempRoot(t, "fnos-phase-138-link-");
  const target = join(root, "target.txt");
  await fsp.writeFile(target, "keep me");
  const link = join(root, "link.txt");
  await fsp.symlink(target, link, "file");
  const { fs, descriptorPathFor } = testFs();
  const manager = createFileManager({ roots: [root], fs, descriptorPathFor });
  const result = await manager.operate({ action: "delete", path: link, capability: DELETE_CAPABILITY });
  assert.equal(result.deleted, true);
  assert.equal(result.symbolicLink, true, "the result says that a link was removed");
  assert.equal(await fsp.readFile(target, "utf8"), "keep me", "the target of the link is untouched");
  await assert.rejects(fsp.lstat(link), error => error.code === "ENOENT", "the link itself is gone");
});

test("a rollback that fails is reported with the original error instead of being swallowed", async t => {
  const { root } = await makeTempRoot(t, "fnos-phase-138-rollback-");
  await fsp.writeFile(join(root, "a.txt"), "a");
  let renames = 0;
  let moved = false;
  const { fs, descriptorPathFor } = testFs({
    // A file system without hard links forces the placeholder strategy.
    link: async () => { const error = new Error("no hard links here"); error.code = "EPERM"; throw error; },
    rename: async (from, to) => {
      renames++;
      if (renames > 1) { const error = new Error("device busy"); error.code = "EBUSY"; throw error; }
      moved = true;
      return fsp.rename(from, to);
    },
    realpath: async (path) => {
      const resolved = await fsp.realpath(path);
      // After the move the parent directory looks different, so the operation
      // is rolled back.
      if (moved && String(path) === root) return resolved + "-drifted";
      return resolved;
    }
  });
  const manager = createFileManager({ roots: [root], fs, descriptorPathFor });
  await assert.rejects(
    manager.operate({ action: "rename", path: join(root, "a.txt"), name: "c.txt" }),
    error => error.statusCode === 409 && error.rollbackError?.code === "EBUSY"
  );
  // The restore refuses to overwrite a name that was taken in the meantime.
  await fsp.writeFile(join(root, "a.txt"), "occupied again");
  await assert.rejects(
    restoreMovedEntry({ fs: fsp, fromPath: join(root, "c.txt"), toPath: join(root, "a.txt"), isDirectory: false, strategy: "link-unlink" }),
    error => error.code === "EEXIST"
  );
});

test("the batch result tells the different 403 reasons apart", async t => {
  const { temp, root } = await makeTempRoot(t, "fnos-phase-138-forbidden-");
  const outside = join(temp, "outside");
  await fsp.mkdir(outside);
  const { fs, descriptorPathFor } = testFs();
  const manager = createFileManager({ roots: [root], fs, descriptorPathFor });
  const results = await manager.operateBatch({ operations: [{ action: "mkdir", path: outside, name: "x" }] });
  assert.equal(results.succeeded, 0);
  assert.equal(results.failed, 1);
  assert.equal(results.results[0].statusCode, 403);
  assert.equal(results.results[0].reason, "Path is outside configured storage roots", "the reason is reported");
  assert.notEqual(results.results[0].error, "操作路径不在允许范围内。", "the 403 is not folded into one sentence");
  assert.equal("stack" in results.results[0], false, "the internal error is not exposed");
});

test("a malformed Base64 payload is a bad request and an oversized one is too large", async () => {
  assert.equal(decodeUploadPayload(Buffer.from("hello").toString("base64")).toString("utf8"), "hello");
  // A payload that is not canonical Base64 is malformed, not too large.
  assert.throws(() => decodeUploadPayload("QR=="), error => error.statusCode === 400);
  assert.throws(() => decodeUploadPayload("not base64!"), error => error.statusCode === 400);
  // A payload that is too large is a capacity problem.
  assert.throws(() => decodeUploadPayload("A".repeat(1398108)), error => error.statusCode === 413);
});

test("an empty answer of the official CLI counts as a successful connection and has the same shape", async () => {
  const adapter = createTrimCliAdapter({
    binaryPath: "/opt/trim-cli",
    accessImpl: async () => {},
    execFileImpl: async () => ({ stdout: "", stderr: "" }),
    env: { PATH: "/usr/bin" },
    now: () => 1700000000000
  });
  const result = await adapter.runReadOnly("system.info");
  assert.deepEqual(result, { command: "system.info", data: null }, "the result shape is the same for an empty answer");
  const health = adapter.connectionHealth();
  assert.equal(health.connectionStatus, "connected");
  assert.equal(health.authenticated, true);
  assert.equal(health.command, "system.info");
});

test("a cut off text answer of the official CLI says that it was cut off", async () => {
  const adapter = createTrimCliAdapter({
    binaryPath: "/opt/trim-cli",
    accessImpl: async () => {},
    execFileImpl: async () => ({ stdout: "x".repeat(70000), stderr: "" })
  });
  const result = await adapter.runReadOnly("system.info");
  assert.equal(result.truncated, true, "the result says that the answer is incomplete");
  assert.equal(result.data.length, 64000);
  assert.equal(result.command, "system.info");
  // A short text answer is not marked as truncated.
  const short = createTrimCliAdapter({
    binaryPath: "/opt/trim-cli",
    accessImpl: async () => {},
    execFileImpl: async () => ({ stdout: "plain text", stderr: "" })
  });
  const plain = await short.runReadOnly("system.info");
  assert.deepEqual(plain, { command: "system.info", data: "plain text" });
});

test("the official CLI refuses a photo keyword that starts with a dash", async () => {
  let calls = 0;
  const adapter = createTrimCliAdapter({
    binaryPath: "/opt/trim-cli",
    accessImpl: async () => {},
    execFileImpl: async () => { calls++; return { stdout: "{}" }; }
  });
  await assert.rejects(adapter.runReadOnly("photos.search", { keyword: "--all" }), { statusCode: 400 });
  await assert.rejects(adapter.runReadOnly("photos.search", { keyword: " -x" }), { statusCode: 400 });
  assert.equal(calls, 0, "the CLI is not called with a keyword that looks like an option");
  await adapter.runReadOnly("photos.search", { keyword: "family album" });
  assert.equal(calls, 1);
});

test("the browser and the file manager order the storage roots in the same way", async () => {
  assert.deepEqual(["/vol2", "/vol1", "/vol10"].sort(compareRootPaths), ["/vol1", "/vol10", "/vol2"]);
  const fakeFs = {
    readdir: async () => [],
    lstat: async () => ({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, size: 0, mtime: new Date(0) }),
    realpath: async path => String(path)
  };
  const browser = createFileBrowser({ roots: ["/vol2", "/vol1"], fs: fakeFs, scanDirectory: async () => ({ entries: [], read: 0, truncated: false }) });
  const manager = createFileManager({ roots: ["/vol2", "/vol1"], fs: fakeFs });
  const browserRoots = (await browser.list("")).roots.map(root => root.path);
  const managerRoots = await manager.getRoots();
  assert.deepEqual(browserRoots, ["/vol1", "/vol2"]);
  assert.deepEqual(managerRoots, browserRoots, "both modules have to agree on the first root");
});

test("the directory counters share one counting basis and the staged files are no entries", async t => {
  const { root } = await makeTempRoot(t, "fnos-phase-138-count-");
  const names = ["alpha.txt", "beta.txt", "gamma.log", "delta.txt", "epsilon.log"];
  const browser = createFileBrowser({
    roots: [root],
    scanDirectory: async () => ({ entries: names.map(name => entry(name, root)), read: names.length, truncated: false })
  });
  const all = await browser.list(root, 100, 0);
  const filtered = await browser.list(root, 100, 0, "directories-first", ".txt");
  assert.equal(all.totalDirectoryEntries, 5, "the directory total counts every scanned entry");
  assert.equal(all.totalEntries, 5, "without a filter the match total is the directory total");
  assert.equal(filtered.totalDirectoryEntries, 5, "the directory total does not depend on the filter");
  assert.equal(filtered.totalEntries, 3, "the match total counts the filtered entries");
  // The pure helper agrees with the browser and ignores the staged files.
  const summary = summarizeDirectoryEntries(
    [...names.map(name => entry(name, root)), entry(TEMP_FILE_PREFIX + "x.tmp", root)],
    { query: ".txt" }
  );
  assert.equal(summary.totalEntries, 3);
  assert.equal(summary.totalDirectoryEntries, 5, "a staged file is not an entry");
});

test("a staged file is published with a rename when the file system has no hard links", async () => {
  const calls = [];
  const fsStub = {
    link: async () => { const error = new Error("no hard links"); error.code = "EPERM"; throw error; },
    rename: async (from, to) => { calls.push(["rename", from, to]); }
  };
  const result = await publishStagedFile({
    fs: fsStub,
    tempPath: "/vol1/.staged.tmp",
    targetPath: "/vol1/result.bin",
    ensureAbsent: async () => { calls.push(["ensureAbsent"]); }
  });
  assert.equal(result, "atomic-rename");
  assert.deepEqual(calls, [["ensureAbsent"], ["rename", "/vol1/.staged.tmp", "/vol1/result.bin"]]);
});

test("a staged file that already exists is refused with 409 and an unexpected error is not swallowed", async () => {
  const existsFs = { link: async () => { const error = new Error("exists"); error.code = "EEXIST"; throw error; } };
  await assert.rejects(
    publishStagedFile({ fs: existsFs, tempPath: "/vol1/.staged.tmp", targetPath: "/vol1/result.bin" }),
    error => error.statusCode === 409 && /already exists/.test(error.message));
  const brokenFs = { link: async () => { const error = new Error("io"); error.code = "EIO"; throw error; } };
  await assert.rejects(
    publishStagedFile({ fs: brokenFs, tempPath: "/vol1/.staged.tmp", targetPath: "/vol1/result.bin" }),
    error => error.code === "EIO" && error.statusCode === undefined);
});

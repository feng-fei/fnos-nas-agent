import { readdir, lstat, realpath, open, opendir } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_ENTRIES = 200;
const DEFAULT_LIMIT = 100;
const MAX_SEARCH_VISITS = 5000;
const MAX_SEARCH_DEPTH = 8;
const MAX_SEARCH_RESULTS = 100;
// A single directory can hold millions of entries. Reading them all and then stat-ing
// every one of them is a denial of service vector, so a listing examines a bounded
// number of entries and reports that it was truncated.
const MAX_SCAN_ENTRIES = 2000;
const MAX_CONTENT_SEARCH_VISITS = 2500;
const MAX_CONTENT_SEARCH_DEPTH = 8;
const MAX_CONTENT_SEARCH_RESULTS = 50;
const MAX_CONTENT_FILE_BYTES = 256 * 1024;
const MAX_CONTENT_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_SEARCH_MS = 3000;
const CONTENT_TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".log", ".csv", ".tsv", ".json", ".jsonl",
  ".yaml", ".yml", ".toml", ".ini", ".conf", ".cfg", ".xml", ".html", ".htm",
  ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".sh", ".bash",
  ".zsh", ".sql", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp"
]);
const CONTENT_SKIP_DIRS = new Set([".git", "node_modules", ".ssh", ".gnupg"]);
const CONTENT_SKIP_NAMES = new Set([
  ".env", ".npmrc", ".pypirc", ".netrc", "_netrc",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"
]);

function isSensitiveContentName(name) {
  const lower = String(name).toLowerCase();
  return CONTENT_SKIP_NAMES.has(lower) ||
    /^\.env(?:\.|$)/i.test(lower) ||
    /(?:^|[._-])(?:credential|credentials|secret|secrets|password|passwd|token|private[-_]?key)(?:[._-]|$)/i.test(lower) ||
    /\.(?:pem|key|p12|pfx|der|crt|cer|jks|keystore)$/i.test(lower);
}

function isContentSearchableName(name) {
  const lower = String(name).toLowerCase();
  if (isSensitiveContentName(lower)) return false;
  const dot = lower.lastIndexOf(".");
  if (dot >= 0 && CONTENT_TEXT_EXTENSIONS.has(lower.slice(dot))) return true;
  return ["readme", "license", "makefile", "dockerfile", "justfile"].includes(lower);
}

function redactContentSnippet(value) {
  return String(value)
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret(?:[_-]?key)?|aws_secret_access_key|password|passwd|authorization)\s*["']?\s*[:=]\s*["']?)[^"'\s,;}{]+/gi, "$1[已隐藏]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g, "[已隐藏令牌]")
    .slice(0, 240);
}

function within(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

export function createFileBrowser({ roots: suppliedRoots, env = process.env, fs = { readdir, lstat, realpath, open, opendir } } = {}) {  function descriptorPath(handle) {
    if (process.platform !== "linux")
      throw Object.assign(new Error("Secure directory browsing requires Linux descriptor paths"), { statusCode: 503 });
    return "/proc/self/fd/" + handle.fd;
  }

  async function openValidatedDirectory(path, expectedInfo) {
    let handle;
    try {
      handle = await fs.open(path, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
      const info = await handle.stat({ bigint: true });
      if (!info.isDirectory() || info.dev !== BigInt(expectedInfo.dev) || info.ino !== BigInt(expectedInfo.ino))
        throw Object.assign(new Error("Directory changed while opening; retry the operation"), { statusCode: 409 });
      return handle;
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (["ELOOP", "ENOENT", "ENOTDIR"].includes(error?.code))
        throw Object.assign(new Error("Directory changed while opening; retry the operation"), { statusCode: 409 });
      throw error;
    }
  }
  // Reads at most `limit` directory entries. The directory is opened through the
  // already validated descriptor, so the entries always come from the pinned inode.
  async function readDirectoryEntries(fdPath, limit) {
    if (typeof fs.opendir === "function") {
      const directory = await fs.opendir(fdPath, { withFileTypes: true });
      const collected = [];
      let truncated = false;
      try {
        for await (const entry of directory) {
          if (collected.length >= limit) { truncated = true; break; }
          collected.push(entry);
        }
      } finally {
        await directory.close().catch(() => {});
      }
      return { entries: collected, truncated };
    }
    const dirents = await fs.readdir(fdPath, { withFileTypes: true });
    return { entries: dirents.slice(0, limit), truncated: dirents.length > limit };
  }
  async function getRoots() {
    let candidates = suppliedRoots;
    if (!Array.isArray(candidates)) {
      const configured = typeof env.AGENT_FILE_ROOTS === "string" ? env.AGENT_FILE_ROOTS.trim() : "";
      if (configured) candidates = configured.split(":").map(item => item.trim()).filter(Boolean);
      else {
        try {
          candidates = (await fs.readdir("/", { withFileTypes: true }))
            .filter(entry => entry.isDirectory() && /^vol[0-9]+$/i.test(entry.name))
            .map(entry => resolve("/", entry.name));
        } catch { candidates = []; }
      }
    }
    const roots = [];
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || !isAbsolute(candidate)) continue;
      try {
        const actual = await fs.realpath(candidate);
        const info = await fs.lstat(actual);
        if (info.isDirectory() && !roots.includes(actual)) roots.push(actual);
      } catch { /* Ignore unavailable configured volumes. */ }
    }
    return roots.sort((a, b) => a.localeCompare(b));
  }

  async function list(pathValue = "", requestedLimit = DEFAULT_LIMIT, requestedOffset = 0, requestedSort = "directories-first", requestedQuery = "", requestedType = "all") {
    if (typeof pathValue !== "string" || pathValue.length > 2048) {
      throw Object.assign(new Error("Invalid directory path"), { statusCode: 400 });
    }
    const roots = await getRoots();
    if (!roots.length) return { roots: [], path: null, parentPath: null, entries: [], limit: 0, offset: 0, totalEntries: 0, note: "未发现可浏览的存储卷；可通过 AGENT_FILE_ROOTS 配置允许的绝对路径。" };
    const requestedPath = pathValue.trim() ? resolve(pathValue) : roots[0];
    let actual;
    try { actual = await fs.realpath(requestedPath); }
    catch { throw Object.assign(new Error("Directory not found"), { statusCode: 404 }); }
    const root = roots.find(candidate => within(candidate, actual));
    if (!root) throw Object.assign(new Error("Path is outside configured storage roots"), { statusCode: 403 });
    const info = await fs.lstat(actual);
    if (!info.isDirectory()) throw Object.assign(new Error("Path is not a directory"), { statusCode: 400 });
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(MAX_ENTRIES, requestedLimit)) : DEFAULT_LIMIT;
    const offset = Number.isInteger(requestedOffset) ? Math.max(0, Math.min(100_000, requestedOffset)) : 0;
    if (!["directories-first", "name-asc", "name-desc", "size-desc", "modified-desc"].includes(requestedSort)) throw Object.assign(new Error("Invalid directory sort mode"), { statusCode: 400 });
    if (typeof requestedQuery !== "string" || requestedQuery.length > 160) throw Object.assign(new Error("Invalid directory search query"), { statusCode: 400 });
    if (!["all", "directory", "file"].includes(requestedType)) throw Object.assign(new Error("Invalid directory type filter"), { statusCode: 400 });
    const handle = await openValidatedDirectory(actual, info);
    const entries = [];
    let truncated = false;
    try {
      const fdPath = descriptorPath(handle);
      const scanned = await readDirectoryEntries(fdPath, MAX_SCAN_ENTRIES);
      truncated = scanned.truncated;
      for (const entry of scanned.entries) {
        if (entry.isSymbolicLink()) continue;
        const fullPath = resolve(actual, entry.name);
        if (!within(root, fullPath)) continue;
        try {
          // Resolve metadata through the opened directory descriptor, not a mutable pathname.
          const stat = await fs.lstat(join(fdPath, entry.name));
          if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue;
          entries.push({
            name: entry.name,
            path: fullPath,
            type: stat.isDirectory() ? "directory" : "file",
            sizeBytes: stat.isFile() ? stat.size : null,
            modifiedAt: stat.mtime.toISOString()
          });
        } catch { /* Ignore entries that disappear during listing. */ }
      }
    } finally {
      await handle.close();
    }
    const totalDirectoryEntries = entries.length;
    const query = requestedQuery.trim().toLocaleLowerCase();
    let filteredEntries = entries.filter(item => (requestedType === "all" || item.type === requestedType) &&
      (!query || item.name.toLocaleLowerCase().includes(query)));
    filteredEntries.sort((a, b) => {
      if (requestedSort === "size-desc") return (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || a.name.localeCompare(b.name);
      if (requestedSort === "modified-desc") return String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")) || a.name.localeCompare(b.name);
      if (requestedSort === "name-desc") return b.name.localeCompare(a.name);
      if (requestedSort === "name-asc") return a.name.localeCompare(b.name);
      return a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1;
    });
    const parent = actual === root ? null : dirname(actual);
    return {
      roots: roots.map(path => ({ name: basename(path), path })),
      path: actual,
      parentPath: parent && within(root, parent) ? parent : null,
      entries: filteredEntries.slice(offset, offset + limit),
      totalEntries: filteredEntries.length,
      totalDirectoryEntries,
      truncated,
      limit,
      offset,
      sort: requestedSort,
      query: requestedQuery.trim(),
      type: requestedType
    };
  }

  async function search(pathValue = "", queryValue, requestedLimit = 50) {
    if (typeof pathValue !== "string" || pathValue.length > 2048 ||
        typeof queryValue !== "string" || !queryValue.trim() || queryValue.length > 200) {
      throw Object.assign(new Error("Invalid file search query"), { statusCode: 400 });
    }
    const roots = await getRoots();
    if (!roots.length) return { roots: [], path: null, query: queryValue.trim(), entries: [], scanned: 0, truncated: false };
    const requestedPath = pathValue.trim() ? resolve(pathValue) : roots[0];
    let start;
    try { start = await fs.realpath(requestedPath); }
    catch { throw Object.assign(new Error("Search directory not found"), { statusCode: 404 }); }
    const root = roots.find(candidate => within(candidate, start));
    if (!root) throw Object.assign(new Error("Path is outside configured storage roots"), { statusCode: 403 });
    const startInfo = await fs.lstat(start);
    if (!startInfo.isDirectory() || startInfo.isSymbolicLink()) throw Object.assign(new Error("Search path is not a directory"), { statusCode: 400 });
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(MAX_SEARCH_RESULTS, requestedLimit)) : 50;
    const needle = queryValue.trim().toLocaleLowerCase();
    const queue = [{ path: start, depth: 0 }];
    const entries = [];
    let scanned = 0, truncated = false;
    while (queue.length && scanned < MAX_SEARCH_VISITS && entries.length < limit) {
      const current = queue.shift();
      let currentPath;
      try { currentPath = await fs.realpath(current.path); }
      catch {
        if (current.depth === 0)
          throw Object.assign(new Error("Directory changed while searching; retry the operation"), { statusCode: 409 });
        continue;
      }
      if (currentPath !== current.path)
        throw Object.assign(new Error("Directory changed while searching; retry the operation"), { statusCode: 409 });
      const currentRoot = roots.find(candidate => within(candidate, currentPath));
      if (!currentRoot) {
        if (current.depth === 0)
          throw Object.assign(new Error("Directory changed while searching; retry the operation"), { statusCode: 409 });
        continue;
      }
      let currentInfo;
      try { currentInfo = await fs.lstat(currentPath); } catch { continue; }
      if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()) continue;
      let handle;
      try {
        handle = await openValidatedDirectory(currentPath, currentInfo);
        const fdPath = descriptorPath(handle);
        const remaining = Math.max(0, Math.min(MAX_SCAN_ENTRIES, MAX_SEARCH_VISITS - scanned));
        const scannedEntries = await readDirectoryEntries(fdPath, remaining);
        if (scannedEntries.truncated) truncated = true;
        for (const entry of scannedEntries.entries) {
          if (scanned >= MAX_SEARCH_VISITS || entries.length >= limit) { truncated = true; break; }
          scanned++;
          if (entry.isSymbolicLink()) continue;
          const fullPath = resolve(currentPath, entry.name);
          if (!within(currentRoot, fullPath)) continue;
          let info;
          try { info = await fs.lstat(join(fdPath, entry.name)); } catch { continue; }
          if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) continue;
          if (entry.name.toLocaleLowerCase().includes(needle)) {
            entries.push({ name: entry.name, path: fullPath, type: info.isDirectory() ? "directory" : "file", sizeBytes: info.isFile() ? info.size : null, modifiedAt: info.mtime.toISOString() });
          }
          if (info.isDirectory() && current.depth < MAX_SEARCH_DEPTH) {
            queue.push({ path: fullPath, depth: current.depth + 1 });
          }
        }
      } catch (error) {
        if (error?.statusCode === 409 || error?.statusCode === 503) throw error;
      } finally {
        if (handle) await handle.close().catch(() => {});
      }
      if (truncated) break;
    }
    if (queue.length && (scanned >= MAX_SEARCH_VISITS || entries.length >= limit)) truncated = true;
    return { roots: roots.map(path => ({ name: basename(path), path })), path: start, query: queryValue.trim(), entries, scanned, truncated };
  }

  async function readSearchableText(fdPath, name, expectedInfo) {
    let handle = null;
    let bytesRead = 0;
    try {
      handle = await fs.open(join(fdPath, name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() ||
          before.dev !== BigInt(expectedInfo.dev) ||
          before.ino !== BigInt(expectedInfo.ino) ||
          before.size > BigInt(MAX_CONTENT_FILE_BYTES)) {
        return { text: null, bytesRead: 0 };
      }
      const expectedSize = Number(before.size);
      const chunks = [];
      let position = 0;
      while (position < expectedSize) {
        const buffer = Buffer.alloc(Math.min(16 * 1024, expectedSize - position));
        const read = await handle.read(buffer, 0, buffer.length, position);
        if (!read.bytesRead) break;
        chunks.push(buffer.subarray(0, read.bytesRead));
        position += read.bytesRead;
      }
      bytesRead = position;
      const after = await handle.stat({ bigint: true });
      if (position !== expectedSize ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeNs !== before.mtimeNs ||
          after.ctimeNs !== before.ctimeNs) {
        return { text: null, bytesRead };
      }
      const data = Buffer.concat(chunks, position);
      if (data.includes(0)) return { text: null, bytesRead };
      try {
        return { text: new TextDecoder("utf-8", { fatal: true }).decode(data), bytesRead };
      } catch {
        return { text: null, bytesRead };
      }
    } catch {
      return { text: null, bytesRead };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function searchContent(pathValue = "", queryValue, requestedLimit = 30) {
    if (typeof pathValue !== "string" || pathValue.length > 2048 ||
        typeof queryValue !== "string" || !queryValue.trim() || queryValue.length > 200) {
      throw Object.assign(new Error("Invalid file content search query"), { statusCode: 400 });
    }
    const roots = await getRoots();
    if (!roots.length) {
      return { roots: [], path: null, query: queryValue.trim(), entries: [], scannedEntries: 0, scannedFiles: 0, bytesRead: 0, skippedLargeFiles: 0, truncated: false };
    }
    const requestedPath = pathValue.trim() ? resolve(pathValue) : roots[0];
    let start;
    try { start = await fs.realpath(requestedPath); }
    catch { throw Object.assign(new Error("Search directory not found"), { statusCode: 404 }); }
    const root = roots.find(candidate => within(candidate, start));
    if (!root) throw Object.assign(new Error("Path is outside configured storage roots"), { statusCode: 403 });
    const startInfo = await fs.lstat(start);
    if (!startInfo.isDirectory() || startInfo.isSymbolicLink()) throw Object.assign(new Error("Search path is not a directory"), { statusCode: 400 });

    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(MAX_CONTENT_SEARCH_RESULTS, requestedLimit)) : 30;
    const needle = queryValue.trim().toLocaleLowerCase();
    const deadline = Date.now() + MAX_CONTENT_SEARCH_MS;
    const queue = [{ path: start, depth: 0 }];
    const entries = [];
    let scannedEntries = 0;
    let scannedFiles = 0;
    let bytesRead = 0;
    let skippedLargeFiles = 0;
    let truncated = false;
    let stop = false;

    while (queue.length && !stop) {
      if (Date.now() >= deadline || scannedEntries >= MAX_CONTENT_SEARCH_VISITS) {
        truncated = true;
        break;
      }
      if (entries.length >= limit) {
        truncated = queue.length > 0;
        break;
      }
      const current = queue.shift();
      let currentPath;
      try { currentPath = await fs.realpath(current.path); }
      catch {
        if (current.depth === 0) throw Object.assign(new Error("Directory changed while searching; retry the operation"), { statusCode: 409 });
        continue;
      }
      if (currentPath !== current.path) {
        if (current.depth === 0) throw Object.assign(new Error("Directory changed while searching; retry the operation"), { statusCode: 409 });
        continue;
      }
      const currentRoot = roots.find(candidate => within(candidate, currentPath));
      if (!currentRoot) {
        if (current.depth === 0) throw Object.assign(new Error("Directory changed while searching; retry the operation"), { statusCode: 409 });
        continue;
      }
      let currentInfo;
      try { currentInfo = await fs.lstat(currentPath); } catch { continue; }
      if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()) continue;

      let handle = null;
      let directoryTruncated = false;
      try {
        handle = await openValidatedDirectory(currentPath, currentInfo);
        const fdPath = descriptorPath(handle);
        const remaining = Math.max(0, Math.min(MAX_SCAN_ENTRIES, MAX_CONTENT_SEARCH_VISITS - scannedEntries));
        const scanned = await readDirectoryEntries(fdPath, remaining);
        directoryTruncated = scanned.truncated;
        for (let index = 0; index < scanned.entries.length; index++) {
          if (Date.now() >= deadline || scannedEntries >= MAX_CONTENT_SEARCH_VISITS) {
            truncated = true;
            stop = true;
            break;
          }
          const entry = scanned.entries[index];
          scannedEntries++;
          if (entry.isSymbolicLink() || CONTENT_SKIP_DIRS.has(entry.name.toLowerCase()) || isSensitiveContentName(entry.name)) continue;
          const fullPath = resolve(currentPath, entry.name);
          if (!within(currentRoot, fullPath)) continue;
          let info;
          try { info = await fs.lstat(join(fdPath, entry.name)); } catch { continue; }
          if (info.isSymbolicLink()) continue;
          if (info.isDirectory()) {
            if (current.depth < MAX_CONTENT_SEARCH_DEPTH) queue.push({ path: fullPath, depth: current.depth + 1 });
            else if (current.depth === MAX_CONTENT_SEARCH_DEPTH) truncated = true;
            continue;
          }
          if (!info.isFile() || !isContentSearchableName(entry.name)) continue;
          if (info.size > MAX_CONTENT_FILE_BYTES) {
            skippedLargeFiles++;
            continue;
          }
          if (bytesRead + info.size > MAX_CONTENT_TOTAL_BYTES) {
            truncated = true;
            stop = true;
            break;
          }
          scannedFiles++;
          const readResult = await readSearchableText(fdPath, entry.name, info);
          bytesRead += readResult.bytesRead;
          if (typeof readResult.text !== "string") continue;
          const lines = readResult.text.split(/\r?\n/);
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex];
            if (!line.toLocaleLowerCase().includes(needle)) continue;
            entries.push({
              name: entry.name,
              path: fullPath,
              lineNumber: lineIndex + 1,
              snippet: redactContentSnippet(line.trim()),
              sizeBytes: info.size,
              modifiedAt: info.mtime.toISOString()
            });
            break;
          }
          if (entries.length >= limit) {
            truncated = index < scanned.entries.length - 1 || scanned.truncated || queue.length > 0;
            stop = true;
            break;
          }
        }
      } catch (error) {
        if (error?.statusCode === 409 || error?.statusCode === 503) throw error;
      } finally {
        if (handle) await handle.close().catch(() => {});
      }
      if (directoryTruncated) {
        truncated = true;
        stop = true;
      }
    }
    return {
      roots: roots.map(path => ({ name: basename(path), path })),
      path: start,
      query: queryValue.trim(),
      entries,
      scannedEntries,
      scannedFiles,
      bytesRead,
      skippedLargeFiles,
      truncated,
      limits: {
        entries: MAX_CONTENT_SEARCH_VISITS,
        depth: MAX_CONTENT_SEARCH_DEPTH,
        fileBytes: MAX_CONTENT_FILE_BYTES,
        totalBytes: MAX_CONTENT_TOTAL_BYTES,
        durationMs: MAX_CONTENT_SEARCH_MS
      }
    };
  }

  return Object.freeze({ list, search, searchContent });
}

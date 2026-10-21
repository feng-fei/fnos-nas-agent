import { readdir, lstat, realpath, open } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_ENTRIES = 200;
const DEFAULT_LIMIT = 100;
const MAX_SEARCH_VISITS = 5000;
const MAX_SEARCH_DEPTH = 8;
const MAX_SEARCH_RESULTS = 100;

function within(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

export function createFileBrowser({ roots: suppliedRoots, env = process.env, fs = { readdir, lstat, realpath, open } } = {}) {
  function descriptorPath(handle) {
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
    try {
      const fdPath = descriptorPath(handle);
      const dirents = await fs.readdir(fdPath, { withFileTypes: true });
      for (const entry of dirents) {
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
        const dirents = await fs.readdir(fdPath, { withFileTypes: true });
        for (const entry of dirents) {
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

  return Object.freeze({ list, search });
}

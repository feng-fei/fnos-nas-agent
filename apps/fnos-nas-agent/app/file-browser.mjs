import { readdir, lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const MAX_ENTRIES = 200;
const DEFAULT_LIMIT = 100;
const MAX_SEARCH_VISITS = 5000;
const MAX_SEARCH_DEPTH = 8;
const MAX_SEARCH_RESULTS = 100;

function within(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

export function createFileBrowser({ roots: suppliedRoots, env = process.env, fs = { readdir, lstat, realpath } } = {}) {
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

  async function list(pathValue = "", requestedLimit = DEFAULT_LIMIT) {
    if (typeof pathValue !== "string" || pathValue.length > 2048) {
      throw Object.assign(new Error("Invalid directory path"), { statusCode: 400 });
    }
    const roots = await getRoots();
    if (!roots.length) return { roots: [], path: null, parentPath: null, entries: [], limit: 0, note: "未发现可浏览的存储卷；可通过 AGENT_FILE_ROOTS 配置允许的绝对路径。" };
    const requestedPath = pathValue.trim() ? resolve(pathValue) : roots[0];
    let actual;
    try { actual = await fs.realpath(requestedPath); }
    catch { throw Object.assign(new Error("Directory not found"), { statusCode: 404 }); }
    const root = roots.find(candidate => within(candidate, actual));
    if (!root) throw Object.assign(new Error("Path is outside configured storage roots"), { statusCode: 403 });
    const info = await fs.lstat(actual);
    if (!info.isDirectory()) throw Object.assign(new Error("Path is not a directory"), { statusCode: 400 });
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(MAX_ENTRIES, requestedLimit)) : DEFAULT_LIMIT;
    const dirents = await fs.readdir(actual, { withFileTypes: true });
    const entries = [];
    for (const entry of dirents) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = resolve(actual, entry.name);
      if (!within(root, fullPath)) continue;
      try {
        const stat = await fs.lstat(fullPath);
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
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
    const parent = actual === root ? null : dirname(actual);
    return {
      roots: roots.map(path => ({ name: basename(path), path })),
      path: actual,
      parentPath: parent && within(root, parent) ? parent : null,
      entries: entries.slice(0, limit),
      totalEntries: entries.length,
      limit
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
      let dirents;
      try { dirents = await fs.readdir(current.path, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of dirents) {
        if (scanned >= MAX_SEARCH_VISITS || entries.length >= limit) { truncated = true; break; }
        scanned++;
        if (entry.isSymbolicLink()) continue;
        const fullPath = resolve(current.path, entry.name);
        if (!within(root, fullPath)) continue;
        let info;
        try { info = await fs.lstat(fullPath); } catch { continue; }
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) continue;
        if (entry.name.toLocaleLowerCase().includes(needle)) {
          entries.push({ name: entry.name, path: fullPath, type: info.isDirectory() ? "directory" : "file", sizeBytes: info.isFile() ? info.size : null, modifiedAt: info.mtime.toISOString() });
        }
        if (info.isDirectory() && current.depth < MAX_SEARCH_DEPTH) {
          try {
            const actual = await fs.realpath(fullPath);
            if (actual === fullPath && within(root, actual)) queue.push({ path: actual, depth: current.depth + 1 });
          } catch { /* Ignore directories that disappear or become inaccessible. */ }
        }
      }
      if (truncated) break;
    }
    if (queue.length && scanned >= MAX_SEARCH_VISITS) truncated = true;
    return { roots: roots.map(path => ({ name: basename(path), path })), path: start, query: queryValue.trim(), entries, scanned, truncated };
  }

  return Object.freeze({ list, search });
}

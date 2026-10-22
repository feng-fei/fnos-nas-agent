import { readdir, lstat, realpath, open, opendir } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
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
const MAX_OFFSET = 100_000;
const SORT_MODES = ["directories-first", "name-asc", "name-desc", "size-desc", "modified-desc"];
const TYPE_FILTERS = ["all", "directory", "file"];
// The file manager stages its writes inside the target directory under this
// prefix. The staged files are internal bookkeeping, so a listing and a
// search never report them: a leftover stage file must not look like user
// content.
export const TEMP_FILE_PREFIX = ".fnos-tmp-";
export function isTemporaryEntryName(name) {
  return typeof name === "string" && name.startsWith(TEMP_FILE_PREFIX);
}
// Case folding that does not depend on the machine locale. A Turkish locale
// would otherwise fold "I" to a dotless "ı" and change which entries match a
// query, so the folding is pinned to NFKC + toLowerCase().
export function foldName(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase();
}

function within(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

// The storage roots decide which volume a client sees first (roots[0] is the
// default browse target), so the file browser and the file manager have to sort
// them with the very same comparison. The comparison is locale independent
// and code unit ordered: it never depends on the machine locale, so the same
// roots always produce the same order.
export function compareRootPaths(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// The name comparison carries a deterministic tie breaker: two names that
// differ only in Unicode normalisation compare equal under localeCompare, and
// the raw readdir order would otherwise decide the page order.
function compareNames(a, b) {
  return a.name.localeCompare(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function publicEntry(item) {
  return {
    name: item.name,
    path: item.path,
    type: item.type,
    sizeBytes: item.sizeBytes ?? null,
    modifiedAt: item.modifiedAt
  };
}

/**
 * Builds the listing summary of one directory scan.
 *
 * Counting contract (both numbers are derived from the very same scan, so they
 * can never disagree about which entries were seen):
 *  - totalDirectoryEntries: every entry the scan observed in the directory.
 *    Symbolic links and non regular files are not entries. Staged write files
 *    (TEMP_FILE_PREFIX) are not entries either. The number is bounded by the
 *    scan limit, therefore a truncated scan reports a lower directory total
 *    and the caller can see the truncation flag.
 *  - totalEntries: the entries that match the query and the type filter. This
 *    is the universe the page (offset/limit) is taken from.
 */
export function summarizeDirectoryEntries(entries, { query = "", type = "all", sort = "directories-first", offset = 0, limit = DEFAULT_LIMIT } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter(item => !isTemporaryEntryName(item?.name));
  const needle = foldName(typeof query === "string" ? query.trim() : "");
  const matched = list.filter(item =>
    (type === "all" || item.type === type) &&
    (!needle || foldName(item.name).includes(needle)));
  const sorted = [...matched].sort((a, b) => {
    if (sort === "size-desc") return (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || compareNames(a, b);
    if (sort === "modified-desc") return String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")) || compareNames(a, b);
    if (sort === "name-desc") return compareNames(b, a) || (a.type === b.type ? 0 : a.type === "directory" ? 1 : -1);
    if (sort === "name-asc") return compareNames(a, b) || (a.type === b.type ? 0 : a.type === "directory" ? 1 : -1);
    return a.type === b.type ? compareNames(a, b) : a.type === "directory" ? -1 : 1;
  });
  const start = Math.max(0, Number.isInteger(offset) ? offset : 0);
  const size = Number.isInteger(limit) ? Math.max(0, limit) : DEFAULT_LIMIT;
  return {
    page: sorted.slice(start, start + size).map(publicEntry),
    totalEntries: matched.length,
    totalDirectoryEntries: list.length,
    directoryVersion: directoryVersion(list)
  };
}

// A fingerprint of the directory content. The offset pagination re-scans the
// directory on every request, so a client cannot tell whether the directory
// changed between two pages. The version makes that drift detectable.
export function directoryVersion(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const hash = createHash("sha256");
  for (const item of list) {
    hash.update(String(item?.name ?? ""));
    hash.update("\u0000");
    hash.update(String(item?.type ?? ""));
    hash.update("\u0000");
    hash.update(String(item?.sizeBytes ?? ""));
    hash.update("\u0000");
    hash.update(String(item?.modifiedAt ?? ""));
    hash.update("\u0000");
  }
  return hash.digest("hex").slice(0, 16);
}

// The pagination is not a snapshot: every page re-scans the directory. The
// hint tells the client how to detect a drift between two pages.
export const OFFSET_DRIFT_HINT = "偏移分页基于每次请求的重新扫描，不是快照：目录内容变化后翻页可能跳过或重复条目，请比较 directoryVersion 是否一致。";

export function createFileBrowser({ roots: suppliedRoots, env = process.env, fs = { readdir, lstat, realpath, open, opendir }, scanDirectory = null, descriptorPathFor = null } = {}) {
  // The descriptor resolver is a test seam: a host that does not offer
  // /proc/self/fd can supply its own resolver. Production never passes one,
  // so the Linux guard below stays in force.
  function descriptorPath(handle) {
    if (typeof descriptorPathFor === "function") return descriptorPathFor(handle);
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
    return roots.sort(compareRootPaths);
  }
  async function isSymbolicLinkPath(path) {
    try { return (await fs.lstat(path)).isSymbolicLink(); }
    catch { return false; }
  }
  // A path that leaves the storage roots and a path that is a symbolic link
  // are two different problems. The second one is reported as such, because
  // "outside the storage roots" would send the caller looking in the wrong
  // place for a path that is perfectly well inside a root.
  async function refuseOutsideRoot(path) {
    const symbolic = await isSymbolicLinkPath(path);
    throw Object.assign(
      new Error(symbolic ? "Symbolic links are not supported" : "Path is outside configured storage roots"),
      { statusCode: 403 });
  }
  // The default scanner pins the directory through an opened descriptor and
  // resolves every entry through that descriptor, so a path that is swapped
  // after the check cannot redirect the listing.
  async function defaultScanDirectory(directoryPath, rootPath, limit) {
    const info = await fs.lstat(directoryPath, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink())
      throw Object.assign(new Error("Path is not a directory"), { statusCode: 400 });
    const handle = await openValidatedDirectory(directoryPath, info);
    try {
      const fdPath = descriptorPath(handle);
      const scanned = await readDirectoryEntries(fdPath, limit);
      const entries = [];
      let skippedSymbolicLinks = 0;
      for (const entry of scanned.entries) {
        // Staged write files are internal bookkeeping, not user content.
        if (isTemporaryEntryName(entry.name)) continue;
        if (entry.isSymbolicLink()) { skippedSymbolicLinks++; continue; }
        const fullPath = resolve(directoryPath, entry.name);
        if (!within(rootPath, fullPath)) continue;
        let stat;
        try {
          // Resolve metadata through the opened directory descriptor, not a mutable pathname.
          stat = await fs.lstat(join(fdPath, entry.name));
        } catch { continue; /* Ignore entries that disappear during listing. */ }
        if (stat.isSymbolicLink()) { skippedSymbolicLinks++; continue; }
        if (!stat.isDirectory() && !stat.isFile()) continue;
        entries.push({
          name: entry.name,
          path: fullPath,
          type: stat.isDirectory() ? "directory" : "file",
          sizeBytes: stat.isFile() ? stat.size : null,
          modifiedAt: stat.mtime.toISOString(),
          isDirectory: stat.isDirectory()
        });
      }
      return { entries, read: scanned.entries.length, truncated: scanned.truncated, skippedSymbolicLinks };
    } finally {
      await handle.close();
    }
  }
  // The seam exists so that the traversal rules can be exercised on platforms
  // that do not offer /proc/self/fd. The production default stays the
  // descriptor pinned scanner above.
  const scan = typeof scanDirectory === "function" ? scanDirectory : defaultScanDirectory;

  // Refuses a symbolic link with a reason of its own. The link may well sit
  // inside a storage root, so "outside the storage roots" would point the
  // caller at the wrong problem.
  async function refuseSymbolicLink(path) {
    if (!await isSymbolicLinkPath(path)) return;
    throw Object.assign(new Error("Symbolic links are not supported"), { statusCode: 403 });
  }
  async function list(pathValue = "", requestedLimit = DEFAULT_LIMIT, requestedOffset = 0, requestedSort = "directories-first", requestedQuery = "", requestedType = "all") {
    if (typeof pathValue !== "string" || pathValue.length > 2048) {
      throw Object.assign(new Error("Invalid directory path"), { statusCode: 400 });
    }
    const roots = await getRoots();
    if (!roots.length) return { roots: [], path: null, parentPath: null, entries: [], limit: 0, offset: 0, totalEntries: 0, totalDirectoryEntries: 0, skippedSymbolicLinks: 0, directoryVersion: "", driftHint: OFFSET_DRIFT_HINT, note: "未发现可浏览的存储卷；可通过 AGENT_FILE_ROOTS 配置允许的绝对路径。" };
    const requestedPath = pathValue.trim() ? resolve(pathValue) : roots[0];
    await refuseSymbolicLink(requestedPath);
    let actual;
    try { actual = await fs.realpath(requestedPath); }
    catch { throw Object.assign(new Error("Directory not found"), { statusCode: 404 }); }
    const root = roots.find(candidate => within(candidate, actual));
    if (!root) await refuseOutsideRoot(requestedPath);
    const info = await fs.lstat(actual);
    if (!info.isDirectory()) throw Object.assign(new Error("Path is not a directory"), { statusCode: 400 });
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(MAX_ENTRIES, requestedLimit)) : DEFAULT_LIMIT;
    const offset = Number.isInteger(requestedOffset) ? Math.max(0, Math.min(MAX_OFFSET, requestedOffset)) : 0;
    if (!SORT_MODES.includes(requestedSort)) throw Object.assign(new Error("Invalid directory sort mode"), { statusCode: 400 });
    if (typeof requestedQuery !== "string" || requestedQuery.length > 160) throw Object.assign(new Error("Invalid directory search query"), { statusCode: 400 });
    if (!TYPE_FILTERS.includes(requestedType)) throw Object.assign(new Error("Invalid directory type filter"), { statusCode: 400 });
    const scanned = await scan(actual, root, MAX_SCAN_ENTRIES);
    const summary = summarizeDirectoryEntries(scanned.entries, { query: requestedQuery, type: requestedType, sort: requestedSort, offset, limit });
    const parent = actual === root ? null : dirname(actual);
    return {
      roots: roots.map(path => ({ name: basename(path), path })),
      path: actual,
      parentPath: parent && within(root, parent) ? parent : null,
      entries: summary.page,
      totalEntries: summary.totalEntries,
      totalDirectoryEntries: summary.totalDirectoryEntries,
      truncated: Boolean(scanned.truncated),
      // The symbolic links of the directory are not listed, but the client
      // still learns how many entries were left out.
      skippedSymbolicLinks: Number.isInteger(scanned.skippedSymbolicLinks) ? scanned.skippedSymbolicLinks : 0,
      directoryVersion: summary.directoryVersion,
      driftHint: OFFSET_DRIFT_HINT,
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
    if (!roots.length) return { roots: [], path: null, query: queryValue.trim(), entries: [], scanned: 0, truncated: false, stopped: false, incomplete: false, partialDirectories: 0, skippedSymbolicLinks: 0 };
    const requestedPath = pathValue.trim() ? resolve(pathValue) : roots[0];
    await refuseSymbolicLink(requestedPath);
    let start;
    try { start = await fs.realpath(requestedPath); }
    catch { throw Object.assign(new Error("Search directory not found"), { statusCode: 404 }); }
    const root = roots.find(candidate => within(candidate, start));
    if (!root) await refuseOutsideRoot(requestedPath);
    const startInfo = await fs.lstat(start);
    if (!startInfo.isDirectory() || startInfo.isSymbolicLink()) throw Object.assign(new Error("Search path is not a directory"), { statusCode: 400 });
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(MAX_SEARCH_RESULTS, requestedLimit)) : 50;
    const needle = foldName(queryValue.trim());
    const queue = [{ path: start, depth: 0 }];
    const entries = [];
    // The two truncation reasons are kept apart:
    //  - truncated: the answer is incomplete, either because the result list
    //    was cut off by the result limit or because a directory was only
    //    partially covered.
    //  - stopped: the traversal ended before the whole tree was covered
    //    (the global visit budget ran out).
    // A single oversized directory only raises partialDirectories; it never
    // ends the traversal, because one huge directory must not hide every
    // other match.
    let scanned = 0, truncated = false, stopped = false, partialDirectories = 0, skippedSymbolicLinks = 0;
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
      let directory = { entries: [], read: 0, truncated: false };
      try {
        const remaining = Math.max(0, Math.min(MAX_SCAN_ENTRIES, MAX_SEARCH_VISITS - scanned));
        directory = await scan(currentPath, currentRoot, remaining);
      } catch (error) {
        if (error?.statusCode === 409 || error?.statusCode === 503) throw error;
      }
      // A directory that holds more entries than the scan budget is only
      // partially covered. That directory is skipped, but the traversal keeps
      // going: one oversized directory must not hide every other match.
      if (directory.truncated) partialDirectories++;
      if (Number.isInteger(directory.skippedSymbolicLinks)) skippedSymbolicLinks += directory.skippedSymbolicLinks;
      scanned += Number.isInteger(directory.read) ? directory.read : 0;
      for (const item of directory.entries) {
        if (entries.length >= limit) { truncated = true; break; }
        if (isTemporaryEntryName(item.name)) continue;
        if (foldName(item.name).includes(needle)) entries.push(publicEntry(item));
        if (item.isDirectory && current.depth < MAX_SEARCH_DEPTH) {
          queue.push({ path: item.path, depth: current.depth + 1 });
        }
      }
    }
    if (scanned >= MAX_SEARCH_VISITS && queue.length) { stopped = true; truncated = true; }
    if (queue.length && entries.length >= limit) truncated = true;
    // A directory that was only partially covered makes the answer
    // incomplete, but it never ends the traversal: the two reasons are kept
    // apart so that the caller can tell a cut off result list from a search
    // that stopped early.
    const incomplete = stopped || partialDirectories > 0;
    return {
      roots: roots.map(path => ({ name: basename(path), path })),
      path: start,
      query: queryValue.trim(),
      entries,
      scanned,
      truncated,
      stopped,
      incomplete,
      partialDirectories,
      skippedSymbolicLinks
    };
  }

  return Object.freeze({ list, search });
}

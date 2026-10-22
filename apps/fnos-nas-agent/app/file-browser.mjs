import { readdir, lstat, realpath, open, opendir } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { classifyPhoto, parseImageMetadata } from "./photo-metadata.mjs";

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

const MAX_CONTENT_SEARCH_VISITS = 2500;
const MAX_CONTENT_SEARCH_DEPTH = 8;
const MAX_CONTENT_SEARCH_RESULTS = 50;
const MAX_CONTENT_FILE_BYTES = 256 * 1024;
const MAX_CONTENT_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_SEARCH_MS = 3000;
const MAX_INSPECT_VISITS = 5000;
const MAX_INSPECT_DEPTH = 8;
const MAX_INSPECT_RESULTS = 20;
const MAX_INSPECT_MS = 4000;
const MAX_PHOTO_VISITS = 2500;
const MAX_PHOTO_DEPTH = 8;
const MAX_PHOTO_RESULTS = 50;
const MAX_PHOTO_SEARCH_MS = 3000;
const MAX_PHOTO_HEADER_BYTES = 128 * 1024;
const MAX_PHOTO_TOTAL_BYTES = 4 * 1024 * 1024;
const PHOTO_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".tif", ".tiff", ".heic"]);
const PHOTO_SKIP_DIRS = new Set([".git", "node_modules", ".ssh", ".gnupg", "secrets", "secret", "credentials", "credential", "private", "keyring"]);
const PHOTO_CATEGORY_LABELS = Object.freeze({ photo: "照片", screenshot: "截图", scan: "扫描件", other: "其他图片" });
const TEMPORARY_EXTENSIONS = new Set([".tmp", ".temp", ".bak", ".old", ".swp", ".cache", ".part", ".partial", ".crdownload", ".download"]);
const SENSITIVE_DIRECTORY_NAMES = new Set(["secrets", "secret", "credentials", "credential", "private", "keyring"]);
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

function isValidDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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

  // Reads the identity of a path. The bigint variant keeps the device and
  // inode numbers exact, because a 64 bit inode does not survive a double.
  async function lstatOrFail(path, message) {
    try { return await fs.lstat(path, { bigint: true }); }
    catch { throw Object.assign(new Error(message), { statusCode: 404 }); }
  }
  async function list(pathValue = "", requestedLimit = DEFAULT_LIMIT, requestedOffset = 0, requestedSort = "directories-first", requestedQuery = "", requestedType = "all") {
    if (typeof pathValue !== "string" || pathValue.length > 2048) {
      throw Object.assign(new Error("Invalid directory path"), { statusCode: 400 });
    }
    const roots = await getRoots();
    if (!roots.length) return { roots: [], path: null, parentPath: null, entries: [], limit: 0, offset: 0, totalEntries: 0, totalDirectoryEntries: 0, skippedSymbolicLinks: 0, directoryVersion: "", driftHint: OFFSET_DRIFT_HINT, note: "未发现可浏览的存储卷；可通过 AGENT_FILE_ROOTS 配置允许的绝对路径。" };
    const requestedPath = pathValue.trim() ? resolve(pathValue) : roots[0];
    // The identity of the requested path is captured before it is resolved.
    // A path that is swapped for a symbolic link in between is a conflict the
    // caller can retry, while a path that was a symbolic link from the start
    // is refused on its own terms. The two must not share a status code.
    const requestedInfo = await lstatOrFail(requestedPath, "Directory not found");
    if (requestedInfo.isSymbolicLink())
      throw Object.assign(new Error("Symbolic links are not supported"), { statusCode: 403 });
    let actual;
    try { actual = await fs.realpath(requestedPath); }
    catch { throw Object.assign(new Error("Directory not found"), { statusCode: 404 }); }
    const info = await lstatOrFail(actual, "Directory not found");
    if (info.dev !== requestedInfo.dev || info.ino !== requestedInfo.ino)
      throw Object.assign(new Error("Directory changed while opening; retry the operation"), { statusCode: 409 });
    const root = roots.find(candidate => within(candidate, actual));
    if (!root) await refuseOutsideRoot(requestedPath);
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
    const requestedInfo = await lstatOrFail(requestedPath, "Search directory not found");
    if (requestedInfo.isSymbolicLink())
      throw Object.assign(new Error("Symbolic links are not supported"), { statusCode: 403 });
    let start;
    try { start = await fs.realpath(requestedPath); }
    catch { throw Object.assign(new Error("Search directory not found"), { statusCode: 404 }); }
    const startInfo = await lstatOrFail(start, "Search directory not found");
    if (startInfo.dev !== requestedInfo.dev || startInfo.ino !== requestedInfo.ino)
      throw Object.assign(new Error("Directory changed while searching; retry the operation"), { statusCode: 409 });
    const root = roots.find(candidate => within(candidate, start));
    if (!root) await refuseOutsideRoot(requestedPath);
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

  async function inspect(pathValue = "", olderThanDays = 90, minBytes = 1024 * 1024, requestedLimit = 10) {
    if (typeof pathValue !== "string" || pathValue.length > 2048 ||
        !Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650 ||
        !Number.isInteger(minBytes) || minBytes < 0 || minBytes > 1_000_000_000 ||
        !Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_INSPECT_RESULTS) {
      throw Object.assign(new Error("Invalid file inspection options"), { statusCode: 400 });
    }
    const roots = await getRoots();
    if (!roots.length) {
      return {
        roots: [], path: null, inspectedAt: new Date().toISOString(), readOnly: true, changedFiles: false,
        filesSeen: 0, directoriesSeen: 0, entriesVisited: 0, observedFileBytes: 0,
        symlinkCount: 0, skippedDirectoryCount: 0, errorCount: 0, partial: false,
        limitHits: [], largestFiles: [], largestDirectories: [], oldLargeCount: 0,
        oldLargeFiles: [], temporaryCandidateCount: 0, temporaryCandidates: [],
        sensitiveNameCount: 0, sensitiveNameCandidates: [],
        note: "没有发现可巡检的存储卷；未读取或修改任何文件。",
        limits: { entries: MAX_INSPECT_VISITS, depth: MAX_INSPECT_DEPTH, durationMs: MAX_INSPECT_MS, results: requestedLimit }
      };
    }
    const requestedPath = pathValue.trim() ? resolve(pathValue) : roots[0];
    let start;
    try { start = await fs.realpath(requestedPath); }
    catch { throw Object.assign(new Error("Inspection directory not found"), { statusCode: 404 }); }
    const root = roots.find(candidate => within(candidate, start));
    if (!root) throw Object.assign(new Error("Path is outside configured storage roots"), { statusCode: 403 });
    const startInfo = await fs.lstat(start);
    if (!startInfo.isDirectory() || startInfo.isSymbolicLink())
      throw Object.assign(new Error("Inspection path is not a directory"), { statusCode: 400 });

    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const deadline = Date.now() + MAX_INSPECT_MS;
    const queue = [{ path: start, depth: 0 }];
    const directoryBytes = new Map([[start, 0]]);
    const largestFiles = [];
    const largestDirectories = [];
    const oldLargeFiles = [];
    const temporaryCandidates = [];
    const sensitiveNameCandidates = [];
    const limitHits = new Set();
    let entriesVisited = 0;
    let filesSeen = 0;
    let directoriesSeen = 0;
    let observedFileBytes = 0;
    let symlinkCount = 0;
    let skippedDirectoryCount = 0;
    let errorCount = 0;
    let oldLargeCount = 0;
    let temporaryCandidateCount = 0;
    let sensitiveNameCount = 0;
    let partial = false;
    let stop = false;

    function keepLargest(list, item) {
      list.push(item);
      list.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0) || a.path.localeCompare(b.path));
      if (list.length > requestedLimit) list.pop();
    }
    function keepSensitive(item) {
      sensitiveNameCount++;
      if (sensitiveNameCandidates.length < requestedLimit) sensitiveNameCandidates.push(item);
    }

    while (queue.length && !stop) {
      if (Date.now() >= deadline) {
        limitHits.add("time");
        partial = true;
        break;
      }
      if (entriesVisited >= MAX_INSPECT_VISITS) {
        limitHits.add("entries");
        partial = true;
        break;
      }
      const current = queue.shift();
      let currentPath;
      try { currentPath = await fs.realpath(current.path); }
      catch {
        if (current.depth === 0) throw Object.assign(new Error("Directory changed while inspecting; retry the operation"), { statusCode: 409 });
        errorCount++;
        continue;
      }
      if (currentPath !== current.path) {
        if (current.depth === 0) throw Object.assign(new Error("Directory changed while inspecting; retry the operation"), { statusCode: 409 });
        errorCount++;
        continue;
      }
      const currentRoot = roots.find(candidate => within(candidate, currentPath));
      if (!currentRoot) {
        if (current.depth === 0) throw Object.assign(new Error("Directory changed while inspecting; retry the operation"), { statusCode: 409 });
        errorCount++;
        continue;
      }
      let currentInfo;
      try { currentInfo = await fs.lstat(currentPath); }
      catch { errorCount++; continue; }
      if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()) continue;

      let handle = null;
      let directoryTruncated = false;
      try {
        handle = await openValidatedDirectory(currentPath, currentInfo);
        const fdPath = descriptorPath(handle);
        const remaining = Math.max(1, Math.min(MAX_SCAN_ENTRIES, MAX_INSPECT_VISITS - entriesVisited));
        const scanned = await readDirectoryEntries(fdPath, remaining);
        directoryTruncated = scanned.truncated;
        for (const entry of scanned.entries) {
          if (Date.now() >= deadline || entriesVisited >= MAX_INSPECT_VISITS) {
            limitHits.add(Date.now() >= deadline ? "time" : "entries");
            partial = true;
            stop = true;
            break;
          }
          entriesVisited++;
          const fullPath = resolve(currentPath, entry.name);
          if (!within(currentRoot, fullPath)) continue;
          if (entry.isSymbolicLink()) {
            symlinkCount++;
            continue;
          }
          let info;
          try { info = await fs.lstat(join(fdPath, entry.name)); }
          catch { errorCount++; continue; }
          if (info.isSymbolicLink()) {
            symlinkCount++;
            continue;
          }
          if (info.isDirectory()) {
            directoriesSeen++;
            directoryBytes.set(fullPath, 0);
            const lower = entry.name.toLowerCase();
            if (CONTENT_SKIP_DIRS.has(lower)) {
              skippedDirectoryCount++;
              continue;
            }
            if (SENSITIVE_DIRECTORY_NAMES.has(lower) || isSensitiveContentName(entry.name)) {
              keepSensitive({ name: entry.name, path: fullPath, type: "directory", reason: "目录名称可能包含敏感信息；未进入该目录" });
              skippedDirectoryCount++;
              continue;
            }
            if (current.depth >= MAX_INSPECT_DEPTH) {
              limitHits.add("depth");
              partial = true;
              continue;
            }
            queue.push({ path: fullPath, depth: current.depth + 1 });
            continue;
          }
          if (!info.isFile()) continue;

          filesSeen++;
          const sizeBytes = Number(info.size);
          observedFileBytes += sizeBytes;
          const record = {
            name: entry.name,
            path: fullPath,
            sizeBytes,
            modifiedAt: info.mtime.toISOString()
          };
          keepLargest(largestFiles, record);

          for (let cursor = currentPath; within(start, cursor); cursor = dirname(cursor)) {
            directoryBytes.set(cursor, (directoryBytes.get(cursor) || 0) + sizeBytes);
            if (cursor === start) break;
            const parentPath = dirname(cursor);
            if (parentPath === cursor) break;
          }

          if (sizeBytes >= minBytes && info.mtimeMs <= cutoff) {
            oldLargeCount++;
            keepLargest(oldLargeFiles, record);
          }
          const extension = entry.name.includes(".") ? entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase() : "";
          if (TEMPORARY_EXTENSIONS.has(extension) || entry.name.endsWith("~")) {
            temporaryCandidateCount++;
            if (temporaryCandidates.length < requestedLimit) temporaryCandidates.push({
              ...record,
              reason: "临时文件或备份文件命名特征；请先确认用途，不会自动删除"
            });
          }
          if (isSensitiveContentName(entry.name)) {
            keepSensitive({ ...record, type: "file", reason: "文件名称可能代表凭据、密钥或敏感配置；未读取内容" });
          }
        }
      } catch (error) {
        if (error?.statusCode === 409 || error?.statusCode === 503) throw error;
        errorCount++;
      } finally {
        if (handle) await handle.close().catch(() => {});
      }
      if (directoryTruncated) {
        limitHits.add("directory-entries");
        partial = true;
        stop = true;
      }
    }

    if (queue.length && (stop || entriesVisited >= MAX_INSPECT_VISITS || Date.now() >= deadline)) partial = true;
    for (const [directoryPath, sizeBytes] of directoryBytes.entries()) {
      if (directoryPath === start || sizeBytes <= 0) continue;
      largestDirectories.push({ name: basename(directoryPath), path: directoryPath, sizeBytes });
    }
    largestDirectories.sort((a, b) => b.sizeBytes - a.sizeBytes || a.path.localeCompare(b.path));
    largestDirectories.splice(requestedLimit);

    return {
      roots: roots.map(path => ({ name: basename(path), path })),
      path: start,
      inspectedAt: new Date().toISOString(),
      readOnly: true,
      changedFiles: false,
      filesSeen,
      directoriesSeen,
      entriesVisited,
      observedFileBytes,
      symlinkCount,
      skippedDirectoryCount,
      errorCount,
      partial,
      limitHits: [...limitHits],
      olderThanDays,
      minBytes,
      largestFiles,
      largestDirectories,
      oldLargeCount,
      oldLargeFiles,
      temporaryCandidateCount,
      temporaryCandidates,
      sensitiveNameCount,
      sensitiveNameCandidates,
      note: partial
        ? "这是部分巡检结果；目录规模、时间或条目上限可能导致遗漏。没有读取文件正文，也没有修改、移动或删除文件。"
        : "巡检已完成。只读取文件系统元数据，没有读取文件正文，也没有修改、移动或删除文件。",
      limits: { entries: MAX_INSPECT_VISITS, depth: MAX_INSPECT_DEPTH, durationMs: MAX_INSPECT_MS, results: requestedLimit }
    };
  }

  async function readPhotoHeader(fdPath, name, expectedInfo) {
    let handle = null;
    let bytesRead = 0;
    try {
      handle = await fs.open(join(fdPath, name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() ||
          before.dev !== BigInt(expectedInfo.dev) ||
          before.ino !== BigInt(expectedInfo.ino)) return { buffer: null, bytesRead: 0 };
      const targetBytes = Math.min(Number(before.size), MAX_PHOTO_HEADER_BYTES);
      const chunks = [];
      let position = 0;
      while (position < targetBytes) {
        const buffer = Buffer.alloc(Math.min(16 * 1024, targetBytes - position));
        const result = await handle.read(buffer, 0, buffer.length, position);
        if (!result.bytesRead) break;
        chunks.push(buffer.subarray(0, result.bytesRead));
        position += result.bytesRead;
      }
      bytesRead = position;
      const after = await handle.stat({ bigint: true });
      if (after.dev !== before.dev || after.ino !== before.ino ||
          after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs)
        return { buffer: null, bytesRead };
      return { buffer: Buffer.concat(chunks, position), bytesRead };
    } catch {
      return { buffer: null, bytesRead };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function searchPhotos({
    path: pathValue = "",
    query: queryValue = "",
    dateFrom = "",
    dateTo = "",
    category = "",
    hasGps = undefined,
    limit: requestedLimit = 20
  } = {}) {
    if (typeof pathValue !== "string" || pathValue.length > 2048 ||
        typeof queryValue !== "string" || queryValue.length > 160 ||
        typeof dateFrom !== "string" || typeof dateTo !== "string" ||
        (dateFrom && !isValidDateOnly(dateFrom)) ||
        (dateTo && !isValidDateOnly(dateTo)) ||
        (dateFrom && dateTo && dateFrom > dateTo) ||
        (category && !Object.hasOwn(PHOTO_CATEGORY_LABELS, category)) ||
        (hasGps !== undefined && typeof hasGps !== "boolean") ||
        !Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_PHOTO_RESULTS) {
      throw Object.assign(new Error("Invalid photo search options"), { statusCode: 400 });
    }
    const roots = await getRoots();
    if (!roots.length) {
      return { roots: [], path: null, query: queryValue.trim(), count: 0, photos: [], scannedEntries: 0, scannedImages: 0, bytesRead: 0, partial: false, limitHits: [] };
    }
    let startPaths;
    if (pathValue.trim()) {
      const requestedPath = resolve(pathValue);
      let actual;
      try { actual = await fs.realpath(requestedPath); }
      catch { throw Object.assign(new Error("Photo search directory not found"), { statusCode: 404 }); }
      const allowedRoot = roots.find(candidate => within(candidate, actual));
      if (!allowedRoot) throw Object.assign(new Error("Path is outside configured storage roots"), { statusCode: 403 });
      const stat = await fs.lstat(actual);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error("Photo search path is not a directory"), { statusCode: 400 });
      startPaths = [{ path: actual, depth: 0, root: allowedRoot }];
    } else {
      startPaths = roots.map(root => ({ path: root, depth: 0, root }));
    }

    const query = queryValue.trim().toLocaleLowerCase();
    const deadline = Date.now() + MAX_PHOTO_SEARCH_MS;
    const queue = [...startPaths];
    const photos = [];
    const limitHits = new Set();
    let scannedEntries = 0;
    let scannedImages = 0;
    let bytesRead = 0;
    let partial = false;
    let stop = false;

    while (queue.length && !stop) {
      if (Date.now() >= deadline || scannedEntries >= MAX_PHOTO_VISITS || bytesRead >= MAX_PHOTO_TOTAL_BYTES) {
        limitHits.add(Date.now() >= deadline ? "time" : bytesRead >= MAX_PHOTO_TOTAL_BYTES ? "bytes" : "entries");
        partial = true;
        break;
      }
      if (photos.length >= requestedLimit) {
        partial = queue.length > 0;
        break;
      }
      const current = queue.shift();
      let currentPath;
      try { currentPath = await fs.realpath(current.path); }
      catch {
        if (current.depth === 0) throw Object.assign(new Error("Directory changed while searching photos; retry the operation"), { statusCode: 409 });
        continue;
      }
      if (currentPath !== current.path) {
        if (current.depth === 0) throw Object.assign(new Error("Directory changed while searching photos; retry the operation"), { statusCode: 409 });
        continue;
      }
      if (!within(current.root, currentPath)) continue;
      let currentInfo;
      try { currentInfo = await fs.lstat(currentPath); } catch { continue; }
      if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()) continue;
      let directoryHandle = null;
      let directoryTruncated = false;
      try {
        directoryHandle = await openValidatedDirectory(currentPath, currentInfo);
        const fdPath = descriptorPath(directoryHandle);
        const remaining = Math.max(1, Math.min(MAX_SCAN_ENTRIES, MAX_PHOTO_VISITS - scannedEntries));
        const scanned = await readDirectoryEntries(fdPath, remaining);
        directoryTruncated = scanned.truncated;
        for (const entry of scanned.entries) {
          if (Date.now() >= deadline || scannedEntries >= MAX_PHOTO_VISITS || bytesRead >= MAX_PHOTO_TOTAL_BYTES) {
            limitHits.add(Date.now() >= deadline ? "time" : bytesRead >= MAX_PHOTO_TOTAL_BYTES ? "bytes" : "entries");
            partial = true;
            stop = true;
            break;
          }
          if (photos.length >= requestedLimit) {
            partial = true;
            stop = true;
            break;
          }
          scannedEntries++;
          const lowerName = entry.name.toLowerCase();
          if (entry.isSymbolicLink() || PHOTO_SKIP_DIRS.has(lowerName) || isSensitiveContentName(lowerName)) continue;
          const fullPath = resolve(currentPath, entry.name);
          if (!within(current.root, fullPath)) continue;
          let info;
          try { info = await fs.lstat(join(fdPath, entry.name)); } catch { continue; }
          if (info.isSymbolicLink()) continue;
          if (info.isDirectory()) {
            if (current.depth < MAX_PHOTO_DEPTH) queue.push({ path: fullPath, depth: current.depth + 1, root: current.root });
            else if (current.depth >= MAX_PHOTO_DEPTH) {
              limitHits.add("depth");
              partial = true;
            }
            continue;
          }
          if (!info.isFile()) continue;
          const extension = lowerName.includes(".") ? lowerName.slice(lowerName.lastIndexOf(".")) : "";
          if (!PHOTO_EXTENSIONS.has(extension)) continue;
          if (bytesRead + Math.min(Math.max(0, Number(info.size)), MAX_PHOTO_HEADER_BYTES) > MAX_PHOTO_TOTAL_BYTES) {
            limitHits.add("bytes");
            partial = true;
            stop = true;
            break;
          }
          const header = await readPhotoHeader(fdPath, entry.name, info);
          bytesRead += header.bytesRead;
          if (!header.buffer) continue;
          scannedImages++;
          const metadata = parseImageMetadata(header.buffer, entry.name);
          const photoCategory = classifyPhoto(entry.name, fullPath, metadata);
          const modifiedAt = info.mtime.toISOString();
          const dateValue = metadata.dateTaken ? metadata.dateTaken.slice(0, 10) : modifiedAt.slice(0, 10);
          if (dateFrom && dateValue < dateFrom) continue;
          if (dateTo && dateValue > dateTo) continue;
          if (category && photoCategory !== category) continue;
          if (hasGps !== undefined && Boolean(metadata.hasGps) !== hasGps) continue;
          if (query && ![
            entry.name, fullPath, metadata.camera, metadata.dateTaken,
            photoCategory, PHOTO_CATEGORY_LABELS[photoCategory]
          ].some(value => String(value || "").toLocaleLowerCase().includes(query))) continue;
          photos.push({
            name: entry.name,
            path: fullPath,
            category: photoCategory,
            categoryLabel: PHOTO_CATEGORY_LABELS[photoCategory],
            sizeBytes: Number(info.size),
            modifiedAt,
            dateTaken: metadata.dateTaken || null,
            dateSource: metadata.dateTaken ? "exif" : "modified",
            camera: metadata.camera || null,
            format: metadata.format || extension.slice(1),
            width: Number.isInteger(metadata.width) ? metadata.width : null,
            height: Number.isInteger(metadata.height) ? metadata.height : null,
            hasGps: Boolean(metadata.hasGps),
            metadataAvailable: Boolean(metadata.metadataAvailable)
          });
        }
      } catch (error) {
        if (error?.statusCode === 409 || error?.statusCode === 503) throw error;
      } finally {
        if (directoryHandle) await directoryHandle.close().catch(() => {});
      }
      if (directoryTruncated) {
        limitHits.add("directory-entries");
        partial = true;
        stop = true;
      }
    }
    if (queue.length && (stop || scannedEntries >= MAX_PHOTO_VISITS || Date.now() >= deadline || bytesRead >= MAX_PHOTO_TOTAL_BYTES)) partial = true;
    photos.sort((a, b) => String(b.dateTaken || b.modifiedAt).localeCompare(String(a.dateTaken || a.modifiedAt)) || a.path.localeCompare(b.path));
    return {
      roots: roots.map(root => ({ name: basename(root), path: root })),
      path: pathValue.trim() || null,
      query: queryValue.trim(),
      filters: { dateFrom: dateFrom || null, dateTo: dateTo || null, category: category || null, hasGps: hasGps === undefined ? null : hasGps },
      count: photos.length,
      photos,
      scannedEntries,
      scannedImages,
      bytesRead,
      partial,
      limitHits: [...limitHits],
      note: "本地图片元数据搜索；只读取图片头部和有限 EXIF 元数据，不解码图片、不返回 GPS 坐标、不上传图片；日期筛选在有 EXIF 拍摄日期时使用拍摄日期，否则使用文件修改日期。",
      limits: { entries: MAX_PHOTO_VISITS, depth: MAX_PHOTO_DEPTH, durationMs: MAX_PHOTO_SEARCH_MS, headerBytesPerImage: MAX_PHOTO_HEADER_BYTES, totalBytes: MAX_PHOTO_TOTAL_BYTES, results: requestedLimit }
    };
  }

  return Object.freeze({ list, search, searchContent, inspect, searchPhotos });
}

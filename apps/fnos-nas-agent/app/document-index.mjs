import { open, mkdir, rename, chmod, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname, relative, sep, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

const INDEX_VERSION = 1;
const INDEX_FILE_NAME = "document-index.json";
const MAX_INDEX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DOCUMENTS = 500;
const MAX_SCANNED_ENTRIES = 6000;
const MAX_DEPTH = 8;
const MAX_REFRESH_MS = 8000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_READ_BYTES = 8 * 1024 * 1024;
const MAX_TERMS_PER_DOCUMENT = 160;
const MAX_SNIPPETS_PER_DOCUMENT = 8;
const PAGE_SIZE = 200;
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".html", ".htm", ".xml", ".log"]);
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".ssh", ".gnupg", "secrets", "secret", "credentials", "credential", "private", "keyring"]);
const SENSITIVE_NAMES = new Set([".env", ".npmrc", ".pypirc", ".netrc", "_netrc", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);

function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}
function within(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}
function sensitiveName(name) {
  const lower = String(name).toLowerCase();
  return SENSITIVE_NAMES.has(lower) ||
    /^\.env(?:\.|$)/i.test(lower) ||
    /(?:^|[._-])(?:credential|credentials|secret|secrets|password|passwd|token|private[-_]?key)(?:[._-]|$)/i.test(lower) ||
    /\.(?:pem|key|p12|pfx|der|crt|cer|jks|keystore)$/i.test(lower);
}
function supportedText(name) {
  const lower = String(name).toLowerCase();
  if (sensitiveName(lower)) return false;
  const dot = lower.lastIndexOf(".");
  if (dot >= 0) return TEXT_EXTENSIONS.has(lower.slice(dot));
  return ["readme", "license", "makefile"].includes(lower);
}
function redact(text) {
  return String(text)
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret(?:[_-]?key)?|aws_secret_access_key|password|passwd|authorization)\s*["']?\s*[:=]\s*["']?)[^"'\s,;}{]+/gi, "$1[已隐藏]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g, "[已隐藏令牌]")
    .slice(0, 220);
}
function termsFor(text) {
  const lower = String(text).toLocaleLowerCase();
  const terms = new Set();
  for (const match of lower.matchAll(/[a-z0-9][a-z0-9_.-]{1,63}/g)) {
    terms.add(match[0].slice(0, 64));
    if (terms.size >= MAX_TERMS_PER_DOCUMENT) return [...terms];
  }
  for (const match of lower.matchAll(/[\u3400-\u9fff]{2,}/g)) {
    const run = match[0].slice(0, 80);
    terms.add(run);
    for (let i = 0; i + 1 < run.length && terms.size < MAX_TERMS_PER_DOCUMENT; i++) terms.add(run.slice(i, i + 2));
    if (terms.size >= MAX_TERMS_PER_DOCUMENT) break;
  }
  return [...terms].slice(0, MAX_TERMS_PER_DOCUMENT);
}
function safeSnippets(content) {
  const rows = [];
  for (const line of String(content).split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    const snippet = redact(raw);
    if (!snippet || rows.includes(snippet)) continue;
    rows.push(snippet);
    if (rows.length >= MAX_SNIPPETS_PER_DOCUMENT) break;
  }
  return rows;
}
function emptyIndex() {
  return { version: INDEX_VERSION, updatedAt: null, partial: false, lastRefresh: null, documents: [] };
}
function validateIndex(value) {
  if (!value || value.version !== INDEX_VERSION || !Array.isArray(value.documents) || value.documents.length > MAX_DOCUMENTS)
    fail(503, "Local document index is invalid; run a full refresh to rebuild it");
  for (const item of value.documents) {
    if (!item || typeof item.path !== "string" || typeof item.name !== "string" ||
        !Array.isArray(item.terms) || !Array.isArray(item.snippets) ||
        typeof item.sizeBytes !== "number" || typeof item.modifiedAt !== "string") {
      fail(503, "Local document index has an unsupported schema; run a full refresh to rebuild it");
    }
  }
  return value;
}

export function createLocalDocumentIndex({ dataDir, fileBrowser, fileManager, now = () => new Date().toISOString() } = {}) {
  if (typeof dataDir !== "string" || !dataDir.trim()) throw new TypeError("dataDir is required");
  if (!fileBrowser || typeof fileBrowser.list !== "function") throw new TypeError("fileBrowser is required");
  if (!fileManager || typeof fileManager.preview !== "function") throw new TypeError("fileManager is required");
  const indexPath = join(dataDir, INDEX_FILE_NAME);
  let refreshInFlight = null;

  async function loadIndex() {
    let handle;
    try {
      handle = await open(indexPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_INDEX_FILE_BYTES) fail(503, "Local document index is not a bounded regular file");
      await handle.chmod(0o600);
      const value = JSON.parse(await handle.readFile({ encoding: "utf8" }));
      return validateIndex(value);
    } catch (error) {
      if (error?.code === "ENOENT") return emptyIndex();
      if (error?.code === "ELOOP") fail(503, "Local document index must not be a symbolic link");
      if (error instanceof SyntaxError) fail(503, "Local document index is malformed; run a full refresh to rebuild it");
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function persistIndex(value) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    if (payload.length > MAX_INDEX_FILE_BYTES) fail(413, "Local document index reached its size limit; reduce the indexed document count");
    const tempPath = join(dataDir, ".document-index-" + randomUUID() + ".tmp");
    let handle;
    let renamed = false;
    try {
      handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      await handle.writeFile(payload);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(tempPath, indexPath);
      renamed = true;
      await chmod(indexPath, 0o600);
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (!renamed) await unlink(tempPath).catch(() => {});
    }
  }

  function statusOf(index) {
    return {
      version: index.version,
      documentCount: index.documents.length,
      indexedBytes: index.documents.reduce((sum, doc) => sum + doc.sizeBytes, 0),
      updatedAt: index.updatedAt,
      partial: index.partial,
      lastRefresh: index.lastRefresh,
      storage: "private local app data",
      supportedExtensions: [...TEXT_EXTENSIONS]
    };
  }

  async function status() {
    return statusOf(await loadIndex());
  }

  async function search(query, requestedLimit = 10) {
    if (typeof query !== "string" || !query.trim() || query.length > 160 ||
        !Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 20) {
      fail(400, "Invalid local document search options");
    }
    const index = await loadIndex();
    const queryTerms = termsFor(query.trim());
    if (!queryTerms.length) return { query: query.trim(), count: 0, results: [], index: statusOf(index) };
    const querySet = new Set(queryTerms);
    const results = [];
    for (const doc of index.documents) {
      const matches = doc.terms.filter(term => querySet.has(term));
      if (!matches.length) continue;
      const scoredSnippets = doc.snippets.map(snippet => ({
        text: snippet,
        score: termsFor(snippet).filter(term => querySet.has(term)).length
      })).sort((a, b) => b.score - a.score);
      results.push({
        name: doc.name,
        path: doc.path,
        extension: doc.extension,
        sizeBytes: doc.sizeBytes,
        modifiedAt: doc.modifiedAt,
        score: matches.length,
        matchedTerms: matches.slice(0, 12),
        snippets: scoredSnippets.slice(0, 3).map(item => item.text)
      });
    }
    results.sort((a, b) => b.score - a.score || String(b.modifiedAt).localeCompare(String(a.modifiedAt)) || a.path.localeCompare(b.path));
    return { query: query.trim(), count: Math.min(results.length, requestedLimit), results: results.slice(0, requestedLimit), index: statusOf(index) };
  }

  async function refresh({ force = false, maxFiles = MAX_DOCUMENTS } = {}) {
    if (typeof force !== "boolean" || !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_DOCUMENTS)
      fail(400, "Invalid local document index refresh options");
    if (refreshInFlight) fail(409, "A document index refresh is already running");
    refreshInFlight = buildIndex({ force, maxFiles });
    try { return await refreshInFlight; }
    finally { refreshInFlight = null; }
  }

  async function buildIndex({ force, maxFiles }) {
    const started = Date.now();
    const deadline = started + MAX_REFRESH_MS;
    const before = await loadIndex();
    const documents = new Map(before.documents.map(doc => [doc.path, doc]));
    const initial = await fileBrowser.list("", 1, 0, "name-asc");
    const roots = Array.isArray(initial.roots) ? initial.roots : [];
    if (!roots.length) {
      const noRootSummary = {
        scannedEntries: 0, scannedFiles: 0, indexedCount: before.documents.length,
        unchangedCount: 0, updatedCount: 0, removedCount: 0, skippedLargeFiles: 0,
        skippedSensitive: 0, unreadableFiles: 0, partial: true,
        limitHits: ["no-roots"], durationMs: Date.now() - started
      };
      return { ...statusOf(before), refresh: noRootSummary };
    }

    let scannedEntries = 0;
    let scannedFiles = 0;
    let candidates = 0;
    let readBytes = 0;
    let unchangedCount = 0;
    let updatedCount = 0;
    let skippedLargeFiles = 0;
    let skippedSensitive = 0;
    let unreadableFiles = 0;
    let partial = false;
    let globalStop = false;
    const limitHits = new Set();
    let removedCount = 0;

    for (const rootInfo of roots) {
      const root = rootInfo.path;
      const queue = [{ path: root, depth: 0 }];
      const seenPaths = new Set();
      let rootComplete = true;
      while (queue.length && !globalStop) {
        if (Date.now() >= deadline) {
          limitHits.add("time");
          partial = true;
          rootComplete = false;
          globalStop = true;
          break;
        }
        if (scannedEntries >= MAX_SCANNED_ENTRIES) {
          limitHits.add("entries");
          partial = true;
          rootComplete = false;
          globalStop = true;
          break;
        }
        if (candidates >= maxFiles) {
          limitHits.add("documents");
          partial = true;
          rootComplete = false;
          globalStop = true;
          break;
        }
        const current = queue.shift();
        let offset = 0;
        let pageTotal = 0;
        let directoryTruncated = false;
        do {
          if (Date.now() >= deadline || scannedEntries >= MAX_SCANNED_ENTRIES) {
            limitHits.add(Date.now() >= deadline ? "time" : "entries");
            partial = true;
            rootComplete = false;
            globalStop = true;
            break;
          }
          let page;
          try { page = await fileBrowser.list(current.path, PAGE_SIZE, offset, "name-asc"); }
          catch {
            unreadableFiles++;
            rootComplete = false;
            break;
          }
          pageTotal = page.totalEntries || 0;
          directoryTruncated = Boolean(page.truncated);
          for (const entry of page.entries || []) {
            scannedEntries++;
            if (entry.type === "directory") {
              const lower = String(entry.name).toLowerCase();
              if (SKIP_DIRECTORIES.has(lower) || sensitiveName(entry.name)) {
                skippedSensitive++;
                continue;
              }
              if (current.depth >= MAX_DEPTH) {
                limitHits.add("depth");
                partial = true;
                rootComplete = false;
                continue;
              }
              queue.push({ path: entry.path, depth: current.depth + 1 });
              continue;
            }
            if (entry.type !== "file") continue;
            scannedFiles++;
            seenPaths.add(entry.path);
            if (sensitiveName(entry.name)) {
              skippedSensitive++;
              documents.delete(entry.path);
              continue;
            }
            if (!supportedText(entry.name)) {
              documents.delete(entry.path);
              continue;
            }
            candidates++;
            if (entry.sizeBytes > MAX_FILE_BYTES) {
              skippedLargeFiles++;
              documents.delete(entry.path);
              continue;
            }
            if (readBytes + (entry.sizeBytes || 0) > MAX_TOTAL_READ_BYTES && (force || !documents.has(entry.path))) {
              limitHits.add("bytes");
              partial = true;
              rootComplete = false;
              globalStop = true;
              break;
            }
            const existing = documents.get(entry.path);
            if (!force && existing && existing.sizeBytes === entry.sizeBytes && existing.modifiedAt === entry.modifiedAt) {
              unchangedCount++;
              continue;
            }
            try {
              const preview = await fileManager.preview(entry.path);
              const content = preview?.content;
              const contentBytes = typeof content === "string" ? Buffer.byteLength(content, "utf8") : 0;
              if (typeof content !== "string" || contentBytes > MAX_FILE_BYTES || content.includes("\0")) {
                unreadableFiles++;
                documents.delete(entry.path);
                continue;
              }
              if (readBytes + contentBytes > MAX_TOTAL_READ_BYTES) {
                limitHits.add("bytes");
                partial = true;
                rootComplete = false;
                globalStop = true;
                break;
              }
              readBytes += contentBytes;
              const sanitized = content.split(/\r?\n/).map(redact).join("\n");
              const doc = {
                path: entry.path,
                name: entry.name,
                extension: entry.name.lastIndexOf(".") >= 0 ? entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase() : "",
                sizeBytes: Number(entry.sizeBytes || contentBytes),
                modifiedAt: String(entry.modifiedAt || ""),
                indexedAt: now(),
                terms: termsFor(sanitized),
                snippets: safeSnippets(sanitized)
              };
              documents.set(entry.path, doc);
              updatedCount++;
            } catch {
              unreadableFiles++;
              documents.delete(entry.path);
            }
          }
          if (globalStop) break;
          offset += (page.entries || []).length;
          if (page.truncated && offset >= pageTotal) {
            limitHits.add("directory-entries");
            partial = true;
            rootComplete = false;
            break;
          }
          if (!page.entries?.length || offset >= pageTotal) break;
        } while (true);
      }
      if (queue.length && !globalStop) {
        rootComplete = false;
        partial = true;
      }
      if (rootComplete) {
        for (const path of [...documents.keys()]) {
          if (within(root, path) && !seenPaths.has(path)) {
            documents.delete(path);
            removedCount++;
          }
        }
      } else {
        partial = true;
      }
      if (globalStop) break;
    }

    const next = {
      version: INDEX_VERSION,
      updatedAt: now(),
      partial,
      lastRefresh: {
        scannedEntries, scannedFiles, indexedCount: documents.size, unchangedCount,
        updatedCount, removedCount, skippedLargeFiles, skippedSensitive, unreadableFiles,
        bytesRead: readBytes, partial, limitHits: [...limitHits], durationMs: Date.now() - started
      },
      documents: [...documents.values()].slice(0, MAX_DOCUMENTS)
    };
    await persistIndex(next);
    return { ...statusOf(next), refresh: next.lastRefresh };
  }

  return Object.freeze({ status, search, refresh });
}

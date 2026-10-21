import { fetchGitHubSkillArchive } from "./skill-remote-import.mjs";
import { MAX_ARCHIVE_BYTES } from "./skill-archives.mjs";

function fail(statusCode, message, code = "SKILL_REMOTE_BATCH_INVALID") {
  throw Object.assign(new Error(message), { statusCode, code });
}

/**
 * Downloads and quarantines a bounded list of GitHub Skill archives sequentially.
 * Each archive uses the existing pinned-commit downloader; total downloaded bytes
 * are capped across the whole batch, and no imported code is executed.
 */
export async function importGitHubSkillBatch(items, {
  fetchArchive = fetchGitHubSkillArchive,
  importArchive,
  maxTotalBytes = MAX_ARCHIVE_BYTES,
  maxItems = 5
} = {}) {
  if (typeof fetchArchive !== "function" || typeof importArchive !== "function")
    throw new TypeError("fetchArchive and importArchive callbacks are required");
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > MAX_ARCHIVE_BYTES)
    throw new TypeError("maxTotalBytes must be between 1 byte and 25 MiB");
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 5)
    throw new TypeError("maxItems must be between 1 and 5");
  if (!Array.isArray(items) || items.length < 1 || items.length > maxItems)
    fail(400, "Submit between 1 and " + maxItems + " GitHub URLs per batch.");

  const results = [];
  const seen = new Set();
  let downloadedBytes = 0;

  for (let offset = 0; offset < items.length; offset++) {
    const index = offset + 1;
    const item = items[offset];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      results.push({ index, ok: false, error: "Each batch item must be an object with a GitHub URL." });
      continue;
    }
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!url || url.length > 2048) {
      results.push({ index, ok: false, error: "GitHub URL must contain 1 to 2048 characters." });
      continue;
    }
    const normalizedUrl = url;
    if (seen.has(normalizedUrl)) {
      results.push({ index, ok: false, error: "Duplicate URL in this batch; skipped." });
      continue;
    }
    seen.add(normalizedUrl);

    const requestedName = item.name === undefined ? "" : typeof item.name === "string" ? item.name.trim() : null;
    const version = item.version === undefined ? "" : typeof item.version === "string" ? item.version.trim() : null;
    if (requestedName === null || (requestedName && requestedName.length > 100)) {
      results.push({ index, ok: false, error: "Skill name must be text and no longer than 100 characters." });
      continue;
    }
    if (version === null || version.length > 40) {
      results.push({ index, ok: false, error: "Skill version must be text and no longer than 40 characters." });
      continue;
    }
    if (downloadedBytes >= maxTotalBytes) {
      results.push({ index, ok: false, skipped: true, error: "The batch reached its cumulative download-size limit; this item was not downloaded." });
      continue;
    }

    let archive = null;
    try {
      archive = await fetchArchive(url, { maxBytes: maxTotalBytes - downloadedBytes });
      if (!archive || !Buffer.isBuffer(archive.buffer) || !Number.isSafeInteger(archive.bytes) ||
          archive.bytes < 1 || archive.bytes !== archive.buffer.length)
        fail(502, "GitHub archive downloader returned invalid size metadata.", "SKILL_REMOTE_BATCH_ARCHIVE_INVALID");
      if (archive.bytes > maxTotalBytes - downloadedBytes)
        fail(413, "This archive exceeds the remaining 25 MiB batch budget.", "SKILL_REMOTE_TOO_LARGE");
      downloadedBytes += archive.bytes;

      const name = requestedName || archive.repository.split("/").at(-1);
      if (!name || name.length > 100)
        fail(400, "Unable to determine a valid Skill name from this repository URL.");
      const sourcePrefix = "GitHub: " + archive.repository +
        (archive.refType && archive.branch ? "@" + archive.refType + "/" + archive.branch : "");
      const sourceLabel = (sourcePrefix.slice(0, Math.max(0, 100 - (archive.commitSha ? 41 : 0))) +
        (archive.commitSha ? "#" + archive.commitSha : "")).slice(0, 100);
      const skill = await importArchive({ name, version, sourceLabel }, archive.buffer);
      results.push({
        index, ok: true, repository: archive.repository, branch: archive.branch,
        refType: archive.refType, commitSha: archive.commitSha,
        archiveBytes: archive.bytes,
        skill: {
          id: skill.id, name: skill.name, state: skill.state,
          archiveSha256: skill.archiveSha256, manifestReview: skill.manifestReview
        }
      });
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
      // A streaming-size failure may happen after consuming the remaining budget.
      // Stop all later downloads when actual bytes consumed cannot be known exactly.
      if (error?.code === "SKILL_REMOTE_TOO_LARGE" || status === 413) downloadedBytes = maxTotalBytes;
      const errorMessage = status >= 500
        ? (typeof error?.code === "string" && error.code.startsWith("SKILL_REMOTE_")
          ? error.message : "Unable to import this GitHub Skill archive.")
        : error.message || "GitHub Skill import failed.";
      results.push({
        index, ok: false,
        ...(archive ? { repository: archive.repository, archiveBytes: archive.bytes } : {}),
        error: errorMessage
      });
    }
  }

  const importedCount = results.filter(item => item.ok).length;
  return Object.freeze({
    total: items.length,
    importedCount,
    failedCount: results.length - importedCount,
    downloadedBytes,
    maxTotalBytes,
    results: Object.freeze(results)
  });
}

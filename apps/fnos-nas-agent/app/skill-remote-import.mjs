const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

function invalid(message, statusCode = 400, code = "SKILL_REMOTE_URL_INVALID") {
  return Object.assign(new Error(message), { statusCode, code });
}

export function validateGitHubArchiveUrl(value) {
  if (typeof value !== "string" || value.length > 2048) {
    throw invalid("Provide a valid GitHub ZIP archive URL.");
  }
  let url;
  try { url = new URL(value); } catch { throw invalid("Provide a valid GitHub ZIP archive URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) {
    throw invalid("Only HTTPS GitHub archive URLs without credentials, ports, queries, or fragments are allowed.");
  }
  const github = url.hostname === "github.com";
  const codeload = url.hostname === "codeload.github.com";
  if (!github && !codeload) throw invalid("Only github.com archive URLs are allowed.");
  let match;
  if (github) {
    match = url.pathname.match(/^\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/archive\/refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+\.zip$/);
    if (!match) throw invalid("Use a GitHub branch or tag ZIP URL ending in /archive/refs/heads/BRANCH.zip or /archive/refs/tags/TAG.zip.");
  } else {
    match = url.pathname.match(/^\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/(?:legacy\.zip\/refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+|zip\/refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+)\/?$/);
    if (!match) throw invalid("GitHub archive redirect URL is not an accepted ZIP path.", 400, "SKILL_REMOTE_REDIRECT_INVALID");
  }
  if (url.pathname.includes("..") || url.pathname.includes("\\") || /%2f|%5c/i.test(url.pathname)) {
    throw invalid("GitHub archive path contains invalid path segments.");
  }
  return { url: url.toString(), repository: match[1] + "/" + match[2] };
}


export function validateGitHubRepositoryUrl(value) {
  if (typeof value !== "string" || value.length > 2048)
    throw invalid("Provide a valid GitHub repository URL.");
  let url;
  try { url = new URL(value); } catch { throw invalid("Provide a valid GitHub repository URL."); }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password ||
      url.port || url.search || url.hash)
    throw invalid("Only plain HTTPS github.com repository URLs are allowed.");
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/?$/);
  if (!match || url.pathname.includes("..") || url.pathname.includes("\\\\"))
    throw invalid("Use the repository root URL: https://github.com/OWNER/REPOSITORY.");
  return { url: "https://github.com/" + match[1] + "/" + match[2], repository: match[1] + "/" + match[2] };
}

function validDefaultBranch(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 ||
      !/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith("/") || value.endsWith("/") ||
      value.includes("..") || value.includes("//")) return false;
  return value.split("/").every(segment =>
    segment && segment !== "." && segment !== ".." && !segment.endsWith(".") && !/\\.lock$/i.test(segment)
  );
}

async function readBoundedBody(response, maxBytes, code, message) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error(message), { statusCode: 502, code });
  }
  const chunks = [];
  let size = 0;
  try {
    if (response.body) for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw Object.assign(new Error(message), { statusCode: 502, code });
      chunks.push(buffer);
    }
  } catch (error) {
    if (error?.code === code) throw error;
    throw Object.assign(new Error(message), { statusCode: 502, code });
  }
  return Buffer.concat(chunks, size);
}

async function resolveRepositoryArchive(repositoryUrl, repository, fetchImpl, timeoutMs) {
  const apiUrl = "https://api.github.com/repos/" + repository;
  let response;
  try {
    response = await fetchImpl(apiUrl, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/vnd.github+json", "user-agent": "fnos-nas-agent" },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw Object.assign(new Error("Unable to look up GitHub repository metadata (network error or timeout)."), {
      statusCode: 502, code: "SKILL_REMOTE_LOOKUP_FAILED"
    });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error("GitHub repository lookup failed with HTTP " + response.status + "."), {
      statusCode: 502, code: "SKILL_REMOTE_LOOKUP_FAILED"
    });
  }
  let metadata;
  try {
    const bytes = await readBoundedBody(response, 16 * 1024, "SKILL_REMOTE_METADATA_TOO_LARGE", "GitHub repository metadata was invalid or too large.");
    metadata = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error?.code?.startsWith("SKILL_REMOTE_")) throw error;
    throw Object.assign(new Error("GitHub repository metadata was invalid or too large."), {
      statusCode: 502, code: "SKILL_REMOTE_METADATA_INVALID"
    });
  }
  const defaultBranch = metadata?.default_branch;
  if (!validDefaultBranch(defaultBranch))
    throw Object.assign(new Error("GitHub repository returned an unsupported default branch name."), {
      statusCode: 502, code: "SKILL_REMOTE_BRANCH_INVALID"
    });
  const [owner, repo] = repository.split("/");
  const archiveUrl = "https://github.com/" + owner + "/" + repo + "/archive/refs/heads/" + defaultBranch + ".zip";
  return { archive: validateGitHubArchiveUrl(archiveUrl), branch: defaultBranch, sourceUrl: repositoryUrl, resolvedFromRepository: true };
}

export async function fetchGitHubSkillArchive(value, {
  fetchImpl = fetch,
  maxBytes = 25 * 1024 * 1024,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 25 * 1024 * 1024)
    throw new TypeError("maxBytes must be between 1 byte and 25 MiB");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000)
    throw new TypeError("timeoutMs must be between 1000 and 30000");
  let sourceUrl = value;
  let current;
  let branch = null;
  let resolvedFromRepository = false;
  try {
    current = validateGitHubArchiveUrl(value);
    sourceUrl = current.url;
  } catch (archiveError) {
    let repositoryInput;
    try { repositoryInput = validateGitHubRepositoryUrl(value); }
    catch { throw archiveError; }
    const resolved = await resolveRepositoryArchive(repositoryInput.url, repositoryInput.repository, fetchImpl, timeoutMs);
    current = resolved.archive;
    sourceUrl = resolved.sourceUrl;
    branch = resolved.branch;
    resolvedFromRepository = resolved.resolvedFromRepository;
  }
  let redirects = 0;
  while (true) {
    let response;
    try {
      response = await fetchImpl(current.url, {
        method: "GET",
        redirect: "manual",
        headers: { accept: "application/zip, application/octet-stream", "user-agent": "fnos-nas-agent" },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      throw Object.assign(new Error("Unable to download the GitHub ZIP archive (network error or timeout)."), {
        statusCode: 502, code: "SKILL_REMOTE_FETCH_FAILED"
      });
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location || redirects >= MAX_REDIRECTS)
        throw invalid("GitHub archive redirect limit exceeded or redirect target missing.", 502, "SKILL_REMOTE_REDIRECT_LIMIT");
      let next;
      try { next = validateGitHubArchiveUrl(new URL(location, current.url).toString()); }
      catch (error) {
        throw Object.assign(new Error("GitHub archive redirected to an unsupported destination."), {
          statusCode: 502, code: "SKILL_REMOTE_REDIRECT_INVALID"
        });
      }
      if (next.repository.toLowerCase() !== current.repository.toLowerCase())
        throw invalid("GitHub archive redirect changed the repository.", 502, "SKILL_REMOTE_REDIRECT_INVALID");
      current = next;
      redirects++;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error("GitHub archive download failed with HTTP " + response.status + "."), {
        statusCode: 502, code: "SKILL_REMOTE_HTTP_FAILED"
      });
    }
    const declared = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error("GitHub ZIP archive exceeds the 25 MiB import limit."), {
        statusCode: 413, code: "SKILL_REMOTE_TOO_LARGE"
      });
    }
    const chunks = [];
    let size = 0;
    try {
      if (response.body) {
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk);
          size += buffer.length;
          if (size > maxBytes) {
            throw Object.assign(new Error("GitHub ZIP archive exceeds the 25 MiB import limit."), {
              statusCode: 413, code: "SKILL_REMOTE_TOO_LARGE"
            });
          }
          chunks.push(buffer);
        }
      }
    } catch (error) {
      if (error?.statusCode) throw error;
      throw Object.assign(new Error("Unable to read the downloaded GitHub ZIP archive."), {
        statusCode: 502, code: "SKILL_REMOTE_READ_FAILED"
      });
    }
    if (!size) throw Object.assign(new Error("GitHub returned an empty ZIP archive."), {
      statusCode: 502, code: "SKILL_REMOTE_EMPTY"
    });
    return { buffer: Buffer.concat(chunks, size), sourceUrl, repository: current.repository, branch, resolvedFromRepository, bytes: size, redirects };
  }
}

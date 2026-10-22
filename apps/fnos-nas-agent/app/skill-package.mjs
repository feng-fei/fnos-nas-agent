import { createHash } from "node:crypto";
import { extractZipEntry } from "./skill-archives.mjs";

/**
 * Phase 144 — Skill package format parser.
 *
 * Reads a Skill archive in memory and describes its canonical package layout:
 *
 *   <root>/SKILL.md          required, frontmatter (name, description) + instructions body
 *   <root>/metadata.json     optional, version / agentApiRange / capabilities / license
 *   <root>/references/**     optional, deep reference material
 *   <root>/scripts/**        optional, helper scripts (never executed here)
 *   <root>/tests/**          optional, package self-checks (never executed here)
 *
 * The parser never writes to disk, never extracts an archive to the filesystem
 * and never executes any imported content. Every problem is reported as a
 * finding instead of being thrown, so a caller can decide what to do with it.
 */

export const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
export const MAX_PACKAGE_ENTRIES = 500;
export const MAX_PACKAGE_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_METADATA_BYTES = 64 * 1024;
export const MAX_INSTRUCTIONS_BYTES = 256 * 1024;
export const MAX_REFERENCE_FILE_BYTES = 1024 * 1024;
export const MAX_SCRIPT_FILE_BYTES = 1024 * 1024;
export const MAX_TEST_FILE_BYTES = 1024 * 1024;
export const MAX_REFERENCE_FILES = 64;
export const MAX_SCRIPT_FILES = 32;
export const MAX_TEST_FILES = 32;
export const MAX_NAME_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_CAPABILITIES = 64;
export const MAX_CAPABILITY_LENGTH = 64;
export const MAX_LICENSE_LENGTH = 100;
export const MAX_AGENT_API_RANGE_LENGTH = 120;
export const MAX_FINDINGS = 64;

export const SKILL_PACKAGE_DIRECTORIES = Object.freeze(["references", "scripts", "tests"]);

const DEFAULT_LIMITS = Object.freeze({
  maxPackageBytes: MAX_PACKAGE_BYTES,
  maxEntries: MAX_PACKAGE_ENTRIES,
  maxUncompressedBytes: MAX_PACKAGE_UNCOMPRESSED_BYTES,
  maxManifestBytes: MAX_MANIFEST_BYTES,
  maxMetadataBytes: MAX_METADATA_BYTES,
  maxInstructionsBytes: MAX_INSTRUCTIONS_BYTES,
  maxReferenceFileBytes: MAX_REFERENCE_FILE_BYTES,
  maxScriptFileBytes: MAX_SCRIPT_FILE_BYTES,
  maxTestFileBytes: MAX_TEST_FILE_BYTES,
  maxReferences: MAX_REFERENCE_FILES,
  maxScripts: MAX_SCRIPT_FILES,
  maxTests: MAX_TEST_FILES,
  maxNameLength: MAX_NAME_LENGTH,
  maxDescriptionLength: MAX_DESCRIPTION_LENGTH,
  maxCapabilities: MAX_CAPABILITIES,
  maxCapabilityLength: MAX_CAPABILITY_LENGTH,
  maxLicenseLength: MAX_LICENSE_LENGTH,
  maxAgentApiRangeLength: MAX_AGENT_API_RANGE_LENGTH,
  maxFindings: MAX_FINDINGS
});

const MANIFEST_PATTERN = /^(?:[^/]+\/)*SKILL\.md$/;
const FIELD_PATTERN = /^([A-Za-z][A-Za-z0-9_-]{0,39})\s*:\s*(.*?)\s*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const RANGE_TOKEN_PATTERN = /^(?:>=|<=|>|<|=|~|\^)?\s*\d+(?:\.(?:\d+|[xX*])){0,2}$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const KNOWN_ROOT_FILE_PATTERN = /^(?:README|LICENSE|NOTICE)(?:\.[A-Za-z0-9]+)?$/;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function hasControlCharacters(text) {
  return [...text].some(char => {
    const code = char.charCodeAt(0);
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31);
  });
}

/** Reads the ZIP central directory without extracting anything. */
function readCentralDirectory(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return { error: "package-not-a-zip" };
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return { error: "package-not-a-zip" };
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff)
    return { error: "package-not-a-zip" };
  if (centralOffset + centralSize > buffer.length || centralOffset + centralSize < centralOffset)
    return { error: "package-not-a-zip" };

  const entries = [];
  let cursor = centralOffset;
  let declaredBytes = 0;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > centralOffset + centralSize) return { error: "package-not-a-zip" };
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) return { error: "package-not-a-zip" };
    const madeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > centralOffset + centralSize) return { error: "package-not-a-zip" };
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeUtf8(nameBytes);
    if (name === null) return { error: "package-not-a-zip" };
    entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localOffset, madeBy, externalAttributes });
    declaredBytes += uncompressedSize;
    cursor = end;
  }
  return { entries, declaredBytes };
}

function isDirectoryEntry(entry) {
  if (entry.name.endsWith("/")) return true;
  const platform = entry.madeBy >>> 8;
  const fileType = (entry.externalAttributes >>> 16) & 0xf000;
  return platform === 3 && fileType === 0x4000;
}

/** Reports every path-safety problem of one archive entry. */
function inspectEntryPath(entry, findings) {
  const name = entry.name;
  if (name.length > 1024) findings.push({ rule: "entry-name-too-long", path: name, message: "Archive entry name exceeds the 1024 byte limit", severity: "error" });
  if (name.includes("\\")) findings.push({ rule: "entry-backslash-path", path: name, message: "Archive entry path uses a backslash separator", severity: "error" });
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) findings.push({ rule: "entry-absolute-path", path: name, message: "Archive entry path is absolute", severity: "error" });
  if (/[\u0000-\u001f\u007f]/.test(name)) findings.push({ rule: "entry-control-characters", path: name, message: "Archive entry path contains control characters", severity: "error" });
  const segments = name.split("/");
  if (segments.some(segment => segment === "..")) findings.push({ rule: "entry-path-traversal", path: name, message: "Archive entry path escapes the package root", severity: "error" });
  if (segments.some(segment => segment === ".")) findings.push({ rule: "entry-current-directory", path: name, message: "Archive entry path contains a current-directory segment", severity: "error" });
  if (segments.some(segment => segment === "")) findings.push({ rule: "entry-empty-path-segment", path: name, message: "Archive entry path contains an empty segment", severity: "error" });
  if (entry.flags & 0x0001) findings.push({ rule: "entry-encrypted", path: name, message: "Encrypted archive entries are not supported", severity: "error" });
  if (entry.flags & 0x0040) findings.push({ rule: "entry-strong-encrypted", path: name, message: "Strong-encrypted archive entries are not supported", severity: "error" });
  if (entry.method !== 0 && entry.method !== 8) findings.push({ rule: "entry-unsupported-compression", path: name, message: "Archive entry uses an unsupported compression method", severity: "error" });
  const platform = entry.madeBy >>> 8;
  const fileType = (entry.externalAttributes >>> 16) & 0xf000;
  if (platform === 3 && fileType === 0xa000) findings.push({ rule: "entry-symbolic-link", path: name, message: "Archive entry is a symbolic link", severity: "error" });
  if (platform === 3 && fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000 && fileType !== 0xa000)
    findings.push({ rule: "entry-special-file-type", path: name, message: "Archive entry is not a regular file", severity: "error" });
}

function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))))
    return value.slice(1, -1);
  return value;
}

function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return { hasFrontmatter: false, fields: {}, body: text };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { hasFrontmatter: false, fields: {}, body: text };
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const match = line.match(FIELD_PATTERN);
    if (!match) continue;
    const key = match[1].toLowerCase().replace(/-/g, "");
    if (!["name", "description", "version", "agentapirange", "capabilities", "license"].includes(key)) continue;
    fields[key] = unquote(match[2]);
  }
  return { hasFrontmatter: true, fields, body: lines.slice(end + 1).join("\n") };
}

function parseCapabilityList(value) {
  if (Array.isArray(value)) return value.filter(item => typeof item === "string").map(item => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map(item => item.trim()).filter(Boolean);
  return [];
}

function isValidAgentApiRange(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const tokens = value.trim().split(/\s+/);
  return tokens.length > 0 && tokens.every(token => token === "*" || RANGE_TOKEN_PATTERN.test(token));
}

/**
 * Parses a Skill archive and describes its package structure.
 *
 * @param {Buffer} buffer ZIP bytes of the Skill archive.
 * @param {{ limits?: object }} [options] Optional limit overrides.
 * @returns {{status: "ok"|"incomplete"|"invalid", manifest: object, instructions: string,
 *   references: object[], scripts: object[], tests: object[], inventory: object[], findings: object[]}}
 */
export function parseSkillPackage(buffer, { limits = {} } = {}) {
  const limit = { ...DEFAULT_LIMITS, ...limits };
  const findings = [];
  const addFinding = (rule, path, message, severity = "error") => {
    if (findings.length < limit.maxFindings) findings.push({ rule, path: path ?? null, message, severity });
  };
  const result = {
    status: "invalid",
    manifest: { name: null, description: null, version: null, agentApiRange: null, capabilities: [], license: null },
    instructions: "",
    references: [],
    scripts: [],
    tests: [],
    inventory: [],
    findings
  };

  if (!Buffer.isBuffer(buffer)) {
    addFinding("package-not-a-zip", null, "Skill package must be a Buffer");
    return Object.freeze({ ...result, findings: Object.freeze(findings) });
  }
  if (buffer.length > limit.maxPackageBytes) {
    addFinding("package-too-large", null, "Skill package exceeds the archive size limit");
    return Object.freeze({ ...result, findings: Object.freeze(findings) });
  }

  const directory = readCentralDirectory(buffer);
  if (directory.error) {
    addFinding("package-not-a-zip", null, "Skill package is not a readable ZIP archive");
    return Object.freeze({ ...result, findings: Object.freeze(findings) });
  }
  if (directory.entries.length > limit.maxEntries) {
    addFinding("package-too-many-entries", null, "Skill package contains too many entries");
    return Object.freeze({ ...result, findings: Object.freeze(findings) });
  }
  if (directory.declaredBytes > limit.maxUncompressedBytes) {
    addFinding("package-uncompressed-size-exceeded", null, "Skill package declares more uncompressed bytes than allowed");
    return Object.freeze({ ...result, findings: Object.freeze(findings) });
  }

  const files = [];
  const seenPaths = new Set();
  for (const entry of directory.entries) {
    if (isDirectoryEntry(entry)) continue;
    inspectEntryPath(entry, findings);
    const key = entry.name.toLowerCase();
    if (seenPaths.has(key)) addFinding("entry-duplicate-path", entry.name, "Skill package contains duplicate entry paths", "error");
    seenPaths.add(key);
    files.push(entry);
  }

  const manifestCandidates = files.filter(entry => MANIFEST_PATTERN.test(entry.name));
  if (manifestCandidates.length === 0) addFinding("missing-skill-manifest", null, "Skill package does not contain a SKILL.md manifest");
  if (manifestCandidates.length > 1) addFinding("multiple-skill-manifests", null, "Skill package contains more than one SKILL.md manifest");
  const manifestEntry = manifestCandidates.length === 1 ? manifestCandidates[0] : null;
  const root = manifestEntry ? manifestEntry.name.slice(0, manifestEntry.name.length - "SKILL.md".length) : "";

  const buckets = { references: [], scripts: [], tests: [], metadata: null };
  for (const entry of files) {
    if (entry === manifestEntry) continue;
    if (root && !entry.name.startsWith(root)) {
      addFinding("entry-outside-package-root", entry.name, "Archive entry lies outside the Skill package root and is ignored", "warning");
      continue;
    }
    const relative = root ? entry.name.slice(root.length) : entry.name;
    if (relative === "metadata.json") { buckets.metadata = entry; continue; }
    const [directoryName, ...rest] = relative.split("/");
    if (rest.length === 0) {
      addFinding(
        "unsupported-package-file",
        relative,
        KNOWN_ROOT_FILE_PATTERN.test(relative)
          ? "Documentation file is not part of the Skill package format and is ignored"
          : "Root file is not part of the Skill package format and is ignored",
        "warning"
      );
      continue;
    }
    if (!SKILL_PACKAGE_DIRECTORIES.includes(directoryName)) {
      addFinding("unsupported-package-directory", relative, "Directory is not part of the Skill package format", "error");
      continue;
    }
    const fileName = rest.join("/");
    if (!fileName) {
      addFinding("unsupported-package-directory", relative, "Directory entry does not name a file", "error");
      continue;
    }
    buckets[directoryName].push({ entry, relative });
  }

  const blocking = findings.some(finding => finding.severity === "error");
  if (blocking) {
    result.status = "invalid";
    return Object.freeze({ ...result, findings: Object.freeze(findings) });
  }

  const extract = (entry, maxBytes, rule) => {
    if (entry.uncompressedSize > maxBytes) {
      addFinding(rule, entry.name, "Skill package file exceeds its size limit");
      return null;
    }
    try {
      return extractZipEntry(buffer, entry.name, maxBytes);
    } catch {
      addFinding("entry-extract-failed", entry.name, "Skill package file could not be read from the archive");
      return null;
    }
  };

  const inventory = [];
  const record = (relative, data) => {
    inventory.push({ path: relative, bytes: data.length, sha256: sha256(data) });
  };

  let frontmatter = { hasFrontmatter: false, fields: {}, body: "" };
  if (manifestEntry) {
    const data = extract(manifestEntry, limit.maxManifestBytes, "manifest-too-large");
    if (data) {
      record(root ? root + "SKILL.md" : "SKILL.md", data);
      const text = decodeUtf8(data);
      if (text === null) addFinding("manifest-not-valid-utf8", manifestEntry.name, "SKILL.md is not valid UTF-8");
      else {
        frontmatter = parseFrontmatter(text);
        if (!frontmatter.hasFrontmatter) addFinding("manifest-missing-frontmatter", manifestEntry.name, "SKILL.md does not start with a frontmatter block");
        if (hasControlCharacters(text)) addFinding("manifest-control-characters", manifestEntry.name, "SKILL.md contains control characters", "warning");
        const body = frontmatter.body.replace(/^\n+/, "");
        if (Buffer.byteLength(body, "utf8") > limit.maxInstructionsBytes)
          addFinding("instructions-too-large", manifestEntry.name, "SKILL.md instructions exceed the size limit");
        else result.instructions = body;
      }
    }
  }

  let metadata = null;
  if (buckets.metadata) {
    const data = extract(buckets.metadata, limit.maxMetadataBytes, "metadata-too-large");
    if (data) {
      record(root ? root + "metadata.json" : "metadata.json", data);
      const text = decodeUtf8(data);
      if (text === null) addFinding("metadata-not-valid-utf8", buckets.metadata.name, "metadata.json is not valid UTF-8");
      else {
        try {
          metadata = JSON.parse(text);
        } catch {
          addFinding("invalid-metadata-json", buckets.metadata.name, "metadata.json is not valid JSON");
        }
        if (metadata !== null && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)))
          addFinding("metadata-not-an-object", buckets.metadata.name, "metadata.json must contain a JSON object");
      }
    }
  } else {
    addFinding("missing-metadata-json", null, "Skill package does not contain a metadata.json file", "warning");
  }

  const frontmatterFields = frontmatter.fields || {};
  const name = frontmatterFields.name || (metadata && typeof metadata.name === "string" ? metadata.name : null);
  const description = frontmatterFields.description || (metadata && typeof metadata.description === "string" ? metadata.description : null);
  if (!frontmatterFields.name && !(metadata && typeof metadata.name === "string"))
    addFinding("missing-name-field", manifestEntry?.name ?? null, "SKILL.md does not declare a name");
  if (!frontmatterFields.description && !(metadata && typeof metadata.description === "string"))
    addFinding("missing-description-field", manifestEntry?.name ?? null, "SKILL.md does not declare a description");
  if (name && name.length > limit.maxNameLength) addFinding("name-too-long", manifestEntry?.name ?? null, "Skill name exceeds the length limit");
  if (description && description.length > limit.maxDescriptionLength) addFinding("description-too-long", manifestEntry?.name ?? null, "Skill description exceeds the length limit");
  if (metadata && typeof metadata.name === "string" && frontmatterFields.name && metadata.name !== frontmatterFields.name)
    addFinding("metadata-name-mismatch", buckets.metadata?.name ?? null, "metadata.json and SKILL.md declare different names");
  if (metadata && typeof metadata.description === "string" && frontmatterFields.description && metadata.description !== frontmatterFields.description)
    addFinding("metadata-description-mismatch", buckets.metadata?.name ?? null, "metadata.json and SKILL.md declare different descriptions");

  const version = (metadata && typeof metadata.version === "string" ? metadata.version : frontmatterFields.version) || null;
  if (version !== null && !VERSION_PATTERN.test(version)) addFinding("invalid-metadata-version", buckets.metadata?.name ?? null, "Skill version must be a semantic version");

  const rawRange = metadata && typeof metadata.agentApiRange === "string" ? metadata.agentApiRange
    : metadata && typeof metadata.agent_api_range === "string" ? metadata.agent_api_range
      : frontmatterFields.agentapirange || null;
  if (rawRange !== null) {
    if (rawRange.length > limit.maxAgentApiRangeLength || !isValidAgentApiRange(rawRange))
      addFinding("invalid-metadata-agent-api-range", buckets.metadata?.name ?? null, "Skill agent API range is not a valid version range");
  }

  const rawCapabilities = metadata && metadata.capabilities !== undefined ? parseCapabilityList(metadata.capabilities)
    : parseCapabilityList(frontmatterFields.capabilities);
  if (rawCapabilities.length > limit.maxCapabilities)
    addFinding("too-many-capabilities", buckets.metadata?.name ?? null, "Skill declares more capabilities than allowed");
  if (rawCapabilities.some(capability => capability.length > limit.maxCapabilityLength || !CAPABILITY_PATTERN.test(capability)))
    addFinding("invalid-metadata-capabilities", buckets.metadata?.name ?? null, "Skill capability identifiers are not valid");

  const license = (metadata && typeof metadata.license === "string" ? metadata.license : frontmatterFields.license) || null;
  if (license !== null && license.length > limit.maxLicenseLength) addFinding("invalid-metadata-license", buckets.metadata?.name ?? null, "Skill license exceeds the length limit");
  if (metadata) {
    for (const key of Object.keys(metadata)) {
      if (!["name", "description", "version", "agentApiRange", "agent_api_range", "capabilities", "license"].includes(key))
        addFinding("unknown-metadata-field", buckets.metadata?.name ?? null, `metadata.json contains an unknown field: ${key}`, "warning");
    }
  }

  const collect = (bucket, maxFiles, maxBytes, kind) => {
    const list = buckets[bucket];
    if (list.length === 0) {
      addFinding(`missing-${bucket}-directory`, null, `Skill package does not contain a ${bucket} directory`, "warning");
      return;
    }
    if (list.length > maxFiles) addFinding(`too-many-${kind}-files`, null, `Skill package contains more than ${maxFiles} ${bucket} files`);
    for (const item of list) {
      const data = extract(item.entry, maxBytes, `${kind}-file-too-large`);
      if (!data) continue;
      record(root + item.relative, data);
      const entry = { path: item.relative, bytes: data.length };
      if (kind !== "test") entry.sha256 = sha256(data);
      result[bucket].push(entry);
    }
  };
  collect("references", limit.maxReferences, limit.maxReferenceFileBytes, "reference");
  collect("scripts", limit.maxScripts, limit.maxScriptFileBytes, "script");
  collect("tests", limit.maxTests, limit.maxTestFileBytes, "test");

  result.manifest = {
    name: name ?? null,
    description: description ?? null,
    version: version ?? null,
    agentApiRange: rawRange ?? null,
    capabilities: rawCapabilities.slice(0, limit.maxCapabilities),
    license: license ?? null
  };
  result.inventory = inventory;

  const hasError = findings.some(finding => finding.severity === "error");
  const hasWarning = findings.some(finding => finding.severity === "warning");
  result.status = hasError ? "invalid" : hasWarning ? "incomplete" : "ok";
  return Object.freeze({ ...result, findings: Object.freeze(findings) });
}

export const SKILL_PACKAGE_LIMITS = DEFAULT_LIMITS;

import { inflateRawSync } from "node:zlib";
import { inspectZipArchive } from "./skill-archives.mjs";

const MANIFEST_LIMIT = 64 * 1024;
const MAX_DESCRIPTION = 1000;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findManifestEntry(buffer) {
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Validated ZIP is missing its directory");
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  let cursor = centralOffset;
  const matches = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Validated ZIP directory changed");
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (/^(?:[^/]+\/)*SKILL\.md$/i.test(name)) {
      matches.push({ name, method, crc, compressedSize, uncompressedSize, localOffset });
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (matches.length > 1) throw Object.assign(new Error("Archive contains multiple SKILL.md manifests"), { statusCode: 400 });
  return matches[0] || null;
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return { fields: {}, hasFrontmatter: false };
  const lines = text.split(/\r?\n/);
  const end = lines.indexOf("---", 1);
  if (end < 0) return { fields: {}, hasFrontmatter: false };
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]{0,39})\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (key !== "name" && key !== "description") continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    fields[key] = value.slice(0, key === "description" ? MAX_DESCRIPTION : 100);
  }
  return { fields, hasFrontmatter: true };
}

/**
 * Extracts only a bounded root/nested SKILL.md payload for static review.
 * Never extracts the archive to disk and never executes imported content.
 */
export function inspectSkillManifest(buffer) {
  const archive = inspectZipArchive(buffer);
  const entry = findManifestEntry(buffer);
  const findings = [];
  if (!entry) {
    return Object.freeze({
      status: "needs_review", manifestFound: false, entryPath: null, name: null, description: null,
      findings: ["missing-skill-manifest"], archiveEntryCount: archive.entryCount
    });
  }
  if (entry.uncompressedSize > MANIFEST_LIMIT) {
    return Object.freeze({
      status: "needs_review", manifestFound: true, entryPath: entry.name, name: null, description: null,
      findings: ["manifest-exceeds-64-kib"], archiveEntryCount: archive.entryCount
    });
  }
  const local = entry.localOffset;
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  let data;
  try {
    data = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MANIFEST_LIMIT });
  } catch {
    return Object.freeze({
      status: "needs_review", manifestFound: true, entryPath: entry.name, name: null, description: null,
      findings: ["manifest-decompression-failed"], archiveEntryCount: archive.entryCount
    });
  }
  if (data.length !== entry.uncompressedSize || data.length > MANIFEST_LIMIT || crc32(data) !== entry.crc) {
    return Object.freeze({
      status: "needs_review", manifestFound: true, entryPath: entry.name, name: null, description: null,
      findings: ["manifest-integrity-check-failed"], archiveEntryCount: archive.entryCount
    });
  }
  let content;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch {
    return Object.freeze({
      status: "needs_review", manifestFound: true, entryPath: entry.name, name: null, description: null,
      findings: ["manifest-not-valid-utf8"], archiveEntryCount: archive.entryCount
    });
  }
  const { fields, hasFrontmatter } = parseFrontmatter(content);
  if (!hasFrontmatter) findings.push("missing-or-invalid-frontmatter");
  if (!fields.name) findings.push("missing-name-field");
  if (!fields.description) findings.push("missing-description-field");
  if (/(?:\bsudo\b|\brm\s+-rf\b|\bcurl\b.{0,80}\|\s*(?:ba)?sh\b|\bwget\b.{0,80}\|\s*(?:ba)?sh\b|\bchmod\s+777\b)/i.test(content)) {
    findings.push("potentially-dangerous-command-text");
  }
  if (/(?:\bexec\b|\bspawn\b|\bchild_process\b|\beval\s*\()/i.test(content)) findings.push("execution-related-text");
  return Object.freeze({
    status: findings.length ? "needs_review" : "manifest_parsed",
    manifestFound: true, entryPath: entry.name, name: fields.name || null,
    description: fields.description || null, findings, archiveEntryCount: archive.entryCount
  });
}

export const MAX_MANIFEST_BYTES = MANIFEST_LIMIT;

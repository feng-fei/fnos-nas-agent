import { createHash, randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { mkdir, writeFile, rename, chmod, lstat, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 500;
export const MAX_DECLARED_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_NAME_BYTES = 1024;
const MAX_CENTRAL_DIRECTORY_BYTES = 1024 * 1024;

function invalid(message) {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

function safeEntryName(name) {
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[a-zA-Z]:/.test(name))
    return false;
  const normalized = name.endsWith("/") ? name.slice(0, -1) : name;
  if (!normalized) return false;
  return normalized.split("/").every(part => part && part !== "." && part !== "..");
}

/**
 * Validates ZIP structure and metadata without extracting or executing any entry.
 * Deliberately supports only single-disk ZIPs with stored/deflated entries.
 */
export function inspectZipArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) invalid("ZIP archive is too small or invalid");
  if (buffer.length > MAX_ARCHIVE_BYTES) throw Object.assign(new Error("ZIP archive exceeds 25 MiB limit"), { statusCode: 413 });

  const min = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0 || eocd + 22 > buffer.length) invalid("ZIP end-of-central-directory record is missing");
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const commentLength = buffer.readUInt16LE(eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) invalid("Multi-disk ZIP archives are not supported");
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) invalid("ZIP64 archives are not supported");
  if (entryCount === 0) invalid("ZIP archive contains no entries");
  if (entryCount > MAX_ARCHIVE_ENTRIES) invalid("ZIP archive has too many entries");
  if (centralSize > MAX_CENTRAL_DIRECTORY_BYTES) invalid("ZIP central directory exceeds limit");
  if (eocd + 22 + commentLength !== buffer.length) invalid("ZIP archive has trailing or malformed data");
  if (centralOffset + centralSize > eocd || centralOffset + centralSize < centralOffset) invalid("ZIP central directory is out of bounds");

  const entries = [];
  const localRanges = [];
  const seen = new Set();
  let cursor = centralOffset;
  let declaredBytes = 0;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > centralOffset + centralSize || buffer.readUInt32LE(cursor) !== 0x02014b50)
      invalid("ZIP central directory entry is malformed");
    const madeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const entryCommentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (!nameLength || nameLength > MAX_NAME_BYTES || end > centralOffset + centralSize)
      invalid("ZIP entry name or metadata exceeds limit");
    if (flags & 0x0001) invalid("Encrypted ZIP entries are not supported");
    if (flags & 0x0040) invalid("Strong-encryption ZIP entries are not supported");
    if (method !== 0 && method !== 8) invalid("ZIP compression method is not supported");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff)
      invalid("ZIP64 entries are not supported");
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString("utf8");
    if (Buffer.from(name, "utf8").compare(nameBytes) !== 0 || !safeEntryName(name))
      invalid("ZIP contains an unsafe or invalid entry path");
    const key = name.toLowerCase();
    if (seen.has(key)) invalid("ZIP contains duplicate entry paths");
    seen.add(key);

    const platform = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & 0xf000;
    if (platform === 3 && fileType === 0xa000) invalid("ZIP symbolic links are not supported");
    if (platform === 3 && fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000)
      invalid("ZIP contains an unsupported special file type");
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50)
      invalid("ZIP local file header is invalid");
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc = buffer.readUInt32LE(localOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(localOffset + 22);
    if (localFlags !== flags || localMethod !== method)
      invalid("ZIP local and central flags or compression methods do not match");
    if (!(flags & 0x0008) && (localCrc !== buffer.readUInt32LE(cursor + 16) ||
        localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize))
      invalid("ZIP local and central size or checksum fields do not match");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > centralOffset || dataEnd > centralOffset || dataEnd < dataStart)
      invalid("ZIP entry data is out of bounds");
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (!localName.equals(nameBytes)) invalid("ZIP local and central entry names do not match");
    if (localRanges.some(range => localOffset < range.end && dataEnd > range.start))
      invalid("ZIP local file records overlap");
    localRanges.push({ start: localOffset, end: dataEnd });
    declaredBytes += uncompressedSize;
    if (declaredBytes > MAX_DECLARED_UNCOMPRESSED_BYTES)
      invalid("ZIP declared uncompressed size exceeds 64 MiB limit");
    entries.push({ name, compressedSize, uncompressedSize, method, crc, localOffset });
    cursor = end;
  }
  if (cursor !== centralOffset + centralSize) invalid("ZIP central directory size does not match its entries");
  return { entryCount, declaredUncompressedBytes: declaredBytes, entries };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Extracts one exact, previously validated ZIP entry into memory; never writes archive paths to disk. */
export function extractZipEntry(buffer, entryName, maxOutputBytes = 16 * 1024 * 1024) {
  const archive = inspectZipArchive(buffer);
  if (typeof entryName !== "string" || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_DECLARED_UNCOMPRESSED_BYTES)
    invalid("Invalid ZIP extraction request");
  const entry = archive.entries.find(item => item.name === entryName);
  if (!entry) throw Object.assign(new Error("Required ZIP entry is missing"), { statusCode: 404 });
  if (entry.uncompressedSize > maxOutputBytes)
    throw Object.assign(new Error("ZIP entry exceeds the extraction size limit"), { statusCode: 413 });
  const local = entry.localOffset;
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  let data;
  try {
    data = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: maxOutputBytes });
  } catch {
    throw Object.assign(new Error("ZIP entry decompression failed"), { statusCode: 400 });
  }
  if (data.length !== entry.uncompressedSize || crc32(data) !== entry.crc)
    throw Object.assign(new Error("ZIP entry integrity check failed"), { statusCode: 400 });
  return Buffer.from(data);
}

export async function saveQuarantinedArchive(dataDir, buffer) {
  const { entryCount, declaredUncompressedBytes, entries } = inspectZipArchive(buffer);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const quarantineDir = join(dataDir, "skill-quarantine");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(quarantineDir, { recursive: true, mode: 0o700 });
  const dirStat = await lstat(quarantineDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw Object.assign(new Error("Quarantine directory is not a safe directory"), { statusCode: 500 });
  await chmod(quarantineDir, 0o700);

  const destination = join(quarantineDir, sha256 + ".zip");
  const temp = join(quarantineDir, "." + randomBytes(12).toString("hex") + ".tmp");
  await writeFile(temp, buffer, { flag: "wx", mode: 0o600 });
  try {
    await chmod(temp, 0o600);
    try {
      await rename(temp, destination);
    } catch (error) {
      await unlink(temp).catch(() => {});
      if (error.code !== "EEXIST") throw error;
    }
    await chmod(destination, 0o600);
    const saved = await readFile(destination);
    if (createHash("sha256").update(saved).digest("hex") !== sha256)
      throw Object.assign(new Error("Quarantined archive verification failed"), { statusCode: 500 });
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return {
    sha256,
    quarantineFile: "skill-quarantine/" + sha256 + ".zip",
    sizeBytes: buffer.length,
    entryCount,
    declaredUncompressedBytes,
    entries
  };
}

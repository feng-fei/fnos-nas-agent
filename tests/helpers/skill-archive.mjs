import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Shared helpers for the Skill archive fixtures.
 *
 * Phase 136 moved the static review to the server: a Skill can only be
 * registered when the quarantined archive is already on disk, because the
 * server reads those bytes itself and derives the review verdict from them.
 * Tests therefore have to place a real archive in the quarantine directory
 * before they register a Skill.
 */

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a small stored-mode ZIP archive with the given entries. */
export function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  let centralSize = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + data.length;
    centralSize += central.length + name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export const sha256 = buffer => createHash("sha256").update(buffer).digest("hex");

/**
 * Stores an archive in the quarantine directory under its own SHA-256 digest
 * and returns that digest, exactly like a real import would.
 */
export async function quarantineArchive(dataDir, archive) {
  const digest = sha256(archive);
  await mkdir(join(dataDir, "skill-quarantine"), { recursive: true });
  await writeFile(join(dataDir, "skill-quarantine", digest + ".zip"), archive);
  return digest;
}

/** A minimal, honest Skill manifest that passes the server side review. */
export const READ_ONLY_MANIFEST =
  "---\nname: sample-skill\ndescription: A minimal read-only Skill used by the integration tests\n---\nOnly reads files.\n";

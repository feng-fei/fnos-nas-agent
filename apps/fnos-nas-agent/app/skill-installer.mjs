import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractZipEntry, inspectZipArchive, MAX_ARCHIVE_BYTES } from "./skill-archives.mjs";

const SUPPORTED = Object.freeze({
  "linux:x64": { key: "linux-x64", entry: "fnos/bin/trim-cli-linux-x64", machine: 62 },
  "linux:arm64": { key: "linux-arm64", entry: "fnos/bin/trim-cli-linux-arm64", machine: 183 }
});
const MAX_CLI_BYTES = 16 * 1024 * 1024;

function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertDirectory(path) {
  return lstat(path).then(info => {
    if (!info.isDirectory() || info.isSymbolicLink()) fail(500, "Skill install directory is not a safe directory");
    return info;
  });
}

function validateElf(buffer, machine) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 64 ||
      buffer[0] !== 0x7f || buffer.toString("ascii", 1, 4) !== "ELF" ||
      buffer[4] !== 2 || buffer[5] !== 1 || buffer.readUInt16LE(18) !== machine) {
    fail(400, "Official CLI binary does not match the target Linux architecture");
  }
}

export function createSkillInstaller({ dataDir, platform = process.platform, arch = process.arch } = {}) {
  if (typeof dataDir !== "string" || !dataDir || !resolve(dataDir).startsWith("/"))
    throw new TypeError("An absolute app data directory is required");

  async function installCli(record) {
    const target = SUPPORTED[`${platform}:${arch}`];
    if (!target) fail(400, "Official CLI installation supports Linux x64 and Linux ARM64 only");
    if (!record || !/^[a-f0-9]{24}$/.test(record.id || "")) fail(400, "Invalid Skill record");
    // Phase 136: the CLI is only installed for a Skill the server itself
    // reviewed, and only for the very archive that was reviewed. A record
    // whose review was declared by a client, or that points at another
    // archive, is refused.
    if (record.manifestReview?.reviewedBy !== "server" ||
        record.manifestReview?.archiveSha256 !== record.archiveSha256) {
      fail(403, "The Skill was not reviewed by the server; re-import the archive before installing its CLI");
    }
    if (!["approved", "enabled"].includes(record.state)) fail(409, "Review and approve the Skill before installing its CLI");
    if (typeof record.name !== "string" || record.name.toLowerCase() !== "fnos" ||
        record.manifestReview?.name?.toLowerCase() !== "fnos" ||
        typeof record.quarantineFile !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.archiveSha256 || "") ||
        record.quarantineFile !== `skill-quarantine/${record.archiveSha256}.zip`) {
      fail(400, "Only a quarantined official fnOS Skill archive can provide the CLI");
    }

    await assertDirectory(resolve(dataDir));
    const quarantineRoot = join(resolve(dataDir), "skill-quarantine");
    await assertDirectory(quarantineRoot);
    const archivePath = join(quarantineRoot, record.archiveSha256 + ".zip");
    const archiveInfo = await lstat(archivePath).catch(() => null);
    if (!archiveInfo || archiveInfo.isSymbolicLink() || !archiveInfo.isFile())
      fail(404, "Quarantined Skill archive is missing or unsafe");
    if (archiveInfo.size > MAX_ARCHIVE_BYTES) fail(413, "Quarantined Skill archive exceeds the size limit");
    const archive = await readFile(archivePath);
    if (sha256(archive) !== record.archiveSha256) fail(400, "Quarantined Skill archive digest does not match");
    const inspected = inspectZipArchive(archive);
    if (!inspected.entries.some(item => item.name === "fnos/SKILL.md"))
      fail(400, "Official Skill manifest entry is missing");

    let manifest;
    try {
      manifest = JSON.parse(extractZipEntry(archive, "fnos/manifest.json", 64 * 1024).toString("utf8"));
    } catch {
      fail(400, "Official fnOS package manifest is invalid");
    }
    if (manifest?.name !== "fnos" || typeof manifest.version !== "string" ||
        manifest.bin?.[target.key] !== target.entry) {
      fail(400, "Package manifest does not declare the expected official fnOS CLI binary");
    }

    // Phase 136: the archive must actually carry the CLI entry that the
    // package manifest declares; the entry is then validated as an ELF.
    if (!inspected.entries.some(item => item.name === target.entry))
      fail(400, "Official fnOS CLI binary entry is missing from the archive");
    const binary = extractZipEntry(archive, target.entry, MAX_CLI_BYTES);
    validateElf(binary, target.machine);

    const installRoot = join(resolve(dataDir), "skill-tools");
    await mkdir(installRoot, { recursive: true, mode: 0o700 });
    await assertDirectory(installRoot);
    const targetDir = join(installRoot, record.id);
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    await assertDirectory(targetDir);
    const targetPath = join(targetDir, "trim-cli");
    const existing = await lstat(targetPath).catch(() => null);
    if (existing && (existing.isSymbolicLink() || !existing.isFile()))
      fail(500, "Existing CLI target is not a regular file");
    const temp = join(targetDir, ".trim-cli-" + randomBytes(12).toString("hex") + ".tmp");
    try {
      await writeFile(temp, binary, { flag: "wx", mode: 0o700 });
      await chmod(temp, 0o700);
      await rename(temp, targetPath);
      await chmod(targetPath, 0o700);
    } finally {
      await unlink(temp).catch(() => {});
    }

    return Object.freeze({
      installed: true,
      skillId: record.id,
      version: manifest.version,
      platform: target.key,
      sizeBytes: binary.length,
      binarySha256: sha256(binary),
      reviewedBy: "server",
      archiveSha256: record.archiveSha256
    });
  }

  return Object.freeze({ installCli });
}

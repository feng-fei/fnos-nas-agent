import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";

const [artifactArg, checksumArg, manifestArg] = process.argv.slice(2);
if (!artifactArg || !checksumArg || !manifestArg) {
  console.error("Usage: node scripts/verify-release-artifact.mjs <artifact.fpk> <artifact.fpk.sha256> <release-manifest.json>");
  process.exit(2);
}

function fail(message) {
  console.error(`Release artifact verification failed: ${message}`);
  process.exit(1);
}

const artifactPath = resolve(artifactArg);
const checksumPath = resolve(checksumArg);
const manifestPath = resolve(manifestArg);

let info;
try {
  info = await stat(artifactPath);
} catch {
  fail("artifact file is missing or unreadable");
}
if (!info.isFile() || info.size <= 0) fail("artifact must be a non-empty regular file");

const checksumText = await readFile(checksumPath, "utf8").catch(() => fail("SHA-256 checksum file is missing or unreadable"));
const checksumLine = checksumText.trim();
const checksumMatch = checksumLine.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
if (!checksumMatch) fail("checksum file must contain one sha256sum-compatible line");
if (basename(checksumMatch[2].trim()) !== basename(artifactPath)) fail("checksum filename does not match the supplied artifact");

const hash = createHash("sha256");
for await (const chunk of createReadStream(artifactPath)) hash.update(chunk);
const actualSha256 = hash.digest("hex");
if (actualSha256 !== checksumMatch[1].toLowerCase()) fail("SHA-256 file does not match the artifact");

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch {
  fail("release manifest is missing, unreadable, or invalid JSON");
}
if (!manifest || manifest.schemaVersion !== 1 || typeof manifest !== "object") fail("unsupported manifest schema");
if (!manifest.artifact || typeof manifest.artifact !== "object") fail("manifest artifact section is missing");
if (manifest.artifact.fileName !== basename(artifactPath)) fail("manifest filename does not match the supplied artifact");
if (!Number.isSafeInteger(manifest.artifact.sizeBytes) || manifest.artifact.sizeBytes !== info.size) fail("manifest size does not match the artifact");
if (typeof manifest.artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.artifact.sha256)) fail("manifest SHA-256 is invalid");
if (manifest.artifact.sha256 !== actualSha256) fail("manifest SHA-256 does not match the artifact");
if (manifest.verification?.checksumAlgorithm !== "sha256") fail("manifest does not declare SHA-256 verification");
if (manifest.verification?.signature !== "not-provided") fail("unexpected signature status; this verifier does not validate signatures");

console.log(`Release artifact verified: ${basename(artifactPath)} (${info.size} bytes, sha256 ${actualSha256})`);
console.log("The checksum and manifest agree with the artifact; this does not verify publisher identity or a cryptographic signature.");

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const artifactArg = process.argv[2];
const outputArg = process.argv[3];
if (!artifactArg || !outputArg) {
  console.error("Usage: node scripts/create-release-manifest.mjs <artifact.fpk> <output.json>");
  process.exit(2);
}

const artifactPath = resolve(artifactArg);
const outputPath = resolve(outputArg);
const info = await stat(artifactPath);
if (!info.isFile() || info.size <= 0) throw new Error("Artifact must be a non-empty regular file");

const hash = createHash("sha256");
for await (const chunk of createReadStream(artifactPath)) hash.update(chunk);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const manifest = {
  schemaVersion: 1,
  artifact: {
    fileName: basename(artifactPath),
    sizeBytes: info.size,
    sha256: hash.digest("hex")
  },
  source: {
    repository: process.env.GITHUB_REPOSITORY || null,
    commit: process.env.GITHUB_SHA || null,
    ref: process.env.GITHUB_REF || null,
    workflow: process.env.GITHUB_WORKFLOW || null,
    runId: process.env.GITHUB_RUN_ID || null
  },
  build: {
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch
  },
  verification: {
    checksumAlgorithm: "sha256",
    signature: "not-provided",
    note: "This manifest records build metadata and detects artifact changes; it is not a cryptographic signature or proof of a trusted builder."
  }
};

await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
console.log(`Release manifest written: ${basename(outputPath)} (${manifest.artifact.sha256})`);

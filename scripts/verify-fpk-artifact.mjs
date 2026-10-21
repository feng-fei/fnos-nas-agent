import { stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/verify-fpk-artifact.mjs <package.fpk>");
  process.exit(2);
}

try {
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) throw new Error("FPK artifact is empty or not a regular file");
  const output = execFileSync("tar", ["-tzf", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const entries = output.split("\n").filter(Boolean);
  if (entries.length === 0 || entries.length > 100_000) throw new Error("FPK entry count is outside the supported bounds");

  const seen = new Set();
  for (const entry of entries) {
    if (entry.startsWith("/") || entry.includes("\\") || entry.includes("\0") ||
        entry.split("/").some(part => part === "..")) {
      throw new Error(`Unsafe archive path: ${JSON.stringify(entry)}`);
    }
    const normalized = entry.replace(/\/+$/, "");
    if (seen.has(normalized)) throw new Error(`Duplicate archive path: ${JSON.stringify(normalized)}`);
    seen.add(normalized);
  }

  for (const required of ["manifest", "app.tgz", "cmd/main"]) {
    if (!seen.has(required)) throw new Error(`Required FPK entry missing: ${required}`);
  }
  console.log(`FPK structure verified: ${entries.length} entries, ${info.size} bytes.`);
} catch (error) {
  console.error(`FPK verification failed: ${error.message}`);
  process.exit(1);
}

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveManifestEntry } from "../apps/fnos-nas-agent/app/skill-installer.mjs";

// The manifest of the official fnOS package, exactly as it ships in the
// released archive: the binary paths are relative to the package root.
const officialManifest = {
  name: "fnos",
  version: "0.1.1",
  entry: "SKILL.md",
  bin: {
    "darwin-arm64": "bin/trim-cli-darwin-arm64",
    "darwin-x64": "bin/trim-cli-darwin-x64",
    "linux-arm64": "bin/trim-cli-linux-arm64",
    "linux-x64": "bin/trim-cli-linux-x64",
    "windows-arm64": "bin/trim-cli-windows-arm64.exe",
    "windows-x64": "bin/trim-cli-windows-x64.exe"
  }
};

test("a binary declared relative to the package root resolves to the archive entry", () => {
  assert.equal(resolveManifestEntry(officialManifest, "linux-x64"), "fnos/bin/trim-cli-linux-x64");
  assert.equal(resolveManifestEntry(officialManifest, "linux-arm64"), "fnos/bin/trim-cli-linux-arm64");
  assert.equal(resolveManifestEntry(officialManifest, "windows-x64"), "fnos/bin/trim-cli-windows-x64.exe");
});

test("a binary that already carries the package folder is accepted unchanged", () => {
  assert.equal(resolveManifestEntry({ name: "fnos", bin: { "linux-x64": "fnos/bin/trim-cli-linux-x64" } }, "linux-x64"), "fnos/bin/trim-cli-linux-x64");
  assert.equal(resolveManifestEntry({ name: "fnos", bin: { "linux-x64": "./fnos/bin/trim-cli-linux-x64" } }, "linux-x64"), "fnos/bin/trim-cli-linux-x64");
});

test("a declared path can never leave the package folder", () => {
  assert.equal(resolveManifestEntry({ name: "fnos", bin: { "linux-x64": "../../etc/passwd" } }, "linux-x64"), "");
  assert.equal(resolveManifestEntry({ name: "fnos", bin: { "linux-x64": "bin/../../evil" } }, "linux-x64"), "");
  assert.equal(resolveManifestEntry({ name: "fnos", bin: { "linux-x64": "fnos/../evil" } }, "linux-x64"), "");
  assert.equal(resolveManifestEntry({ name: "fnos", bin: { "linux-x64": "bin//trim-cli" } }, "linux-x64"), "");
});

test("a missing or malformed declaration resolves to nothing", () => {
  assert.equal(resolveManifestEntry(officialManifest, "linux-riscv"), "");
  assert.equal(resolveManifestEntry({ name: "fnos" }, "linux-x64"), "");
  assert.equal(resolveManifestEntry({ name: "fnos", bin: { "linux-x64": 42 } }, "linux-x64"), "");
  assert.equal(resolveManifestEntry({ name: "fnos", bin: { "linux-x64": "   " } }, "linux-x64"), "");
  assert.equal(resolveManifestEntry(null, "linux-x64"), "");
});

test("the installer compares the resolved entry with the expected one", async () => {
  const source = await readFile(new URL("../apps/fnos-nas-agent/app/skill-installer.mjs", import.meta.url), "utf8");
  assert.match(source, /resolveManifestEntry\(manifest, target\.key\) !== target\.entry/);
  assert.doesNotMatch(source, /manifest\.bin\?\.\[target\.key\] !== target\.entry/);
  assert.match(source, /"linux:x64": \{ key: "linux-x64", entry: "fnos\/bin\/trim-cli-linux-x64", machine: 62 \}/);
  assert.match(source, /"linux:arm64": \{ key: "linux-arm64", entry: "fnos\/bin\/trim-cli-linux-arm64", machine: 183 \}/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPermissionPolicy } from "../apps/fnos-nas-agent/app/permission-policy.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = path => readFile(join(root, path), "utf8");
const [pkg, workflow, server, skills, archives, manifest, ui] = await Promise.all([
  read("package.json"),
  read(".github/workflows/build-fpk.yml"),
  read("apps/fnos-nas-agent/app/server.mjs"),
  read("apps/fnos-nas-agent/app/skills.mjs"),
  read("apps/fnos-nas-agent/app/skill-archives.mjs"),
  read("apps/fnos-nas-agent/app/skill-manifest.mjs"),
  read("apps/fnos-nas-agent/app/ui/index.html")
].map(async promise => promise));
const packageJson = JSON.parse(pkg);

assert.match(packageJson.engines?.node || "", />=\s*24/);
assert.equal(packageJson.dependencies, undefined, "runtime must remain dependency-free");
assert.match(workflow, /node-version:\s*\["24\.x",\s*"26\.x"\]/);
assert.match(workflow, /Build FPK/);
assert.match(workflow, /Inspect package and checksum/);
assert.match(workflow, /node --check "\$app\/app\/request-limiter\.mjs"/);
assert.match(workflow, /node --check \/tmp\/fnos-agent-ui-check\.mjs/);

assert.match(server, /executionEnabled: false/);
assert.doesNotMatch(server, /from\s+["']node:child_process["']/);
assert.doesNotMatch(server, /from\s+["']child_process["']/);
assert.doesNotMatch(server, /approval-ledger\.mjs/);
assert.match(server, /taskManager\.cancel\(/);
assert.match(skills, /inspectSkillManifest\(buffer\)/);
assert.match(skills, /manifestReview: normalizeManifestReview\(input\.manifestReview\)/);
assert.match(archives, /MAX_ARCHIVE_BYTES = 5 \* 1024 \* 1024/);
assert.match(archives, /MAX_DECLARED_UNCOMPRESSED_BYTES = 20 \* 1024 \* 1024/);
assert.match(manifest, /MAX_MANIFEST_BYTES = MANIFEST_LIMIT/);
assert.match(ui, /textContent = "静态清单："/);

const policy = createPermissionPolicy();
assert.equal(policy.evaluate({ risk: "read-only" }).allowed, true);
assert.equal(policy.evaluate({ risk: "write", approved: true }).allowed, false);
assert.equal(policy.evaluate({ risk: "destructive", approved: true }).allowed, false);
assert.equal(policy.snapshot().executionEnabled, false);

console.log("Release readiness gates passed: runtime dependency, CI matrix, packaging, and safety invariants.");

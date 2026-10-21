import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPermissionPolicy } from "../apps/fnos-nas-agent/app/permission-policy.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = path => readFile(join(root, path), "utf8");
const [pkg, workflow, server, skills, archives, manifest, ui, taskManager, auditLog, taskPersistenceTests, readme, releaseManifestScript, releaseManifestTests, releaseManifestDocs, releaseVerifier, releaseVerifierTests, releaseVerifierDocs] = await Promise.all([
  read("package.json"),
  read(".github/workflows/build-fpk.yml"),
  read("apps/fnos-nas-agent/app/server.mjs"),
  read("apps/fnos-nas-agent/app/skills.mjs"),
  read("apps/fnos-nas-agent/app/skill-archives.mjs"),
  read("apps/fnos-nas-agent/app/skill-manifest.mjs"),
  read("apps/fnos-nas-agent/app/ui/index.html"),
  read("apps/fnos-nas-agent/app/task-manager.mjs"),
  read("apps/fnos-nas-agent/app/audit-log.mjs"),
  read("tests/phase-21-task-persistence.test.mjs"),
  read("README.md"),
  read("scripts/create-release-manifest.mjs"),
  read("tests/phase-25-release-manifest.test.mjs"),
  read("docs/phase-25-release-manifest-and-provenance.md"),
  read("scripts/verify-release-artifact.mjs"),
  read("tests/phase-26-release-artifact-verification.test.mjs"),
  read("docs/phase-26-release-artifact-verification.md")
].map(async promise => promise));
const packageJson = JSON.parse(pkg);

assert.match(packageJson.engines?.node || "", />=\s*24/);
assert.equal(packageJson.dependencies, undefined, "runtime must remain dependency-free");
assert.match(workflow, /node-version:\s*\["24\.x",\s*"26\.x"\]/);
assert.match(workflow, /Build FPK/);
assert.match(workflow, /Inspect package and checksum/);
assert.match(workflow, /phase-24-\*/);
assert.match(workflow, /phase-25-\*/);
assert.match(workflow, /create-release-manifest\.mjs/);
assert.match(workflow, /dist\/release-manifest\.json/);
assert.match(workflow, /dist\/release-manifest\.json/);
assert.match(releaseManifestScript, /createHash\("sha256"\)/);
assert.match(releaseManifestScript, /GITHUB_SHA/);
assert.match(releaseManifestScript, /signature: "not-provided"/);
assert.match(releaseManifestTests, /records artifact checksum/);
assert.match(releaseManifestTests, /refuses to overwrite/);
assert.match(releaseManifestDocs, /not a signed attestation/);
assert.match(packageJson.scripts?.["verify:release-artifact"] || "", /verify-release-artifact\.mjs/);
assert.match(workflow, /verify-release-artifact\.mjs/);
assert.match(releaseVerifier, /manifest SHA-256 does not match/);
assert.match(releaseVerifier, /checksum filename does not match/);
assert.match(releaseVerifierTests, /rejects an artifact changed/);
assert.match(releaseVerifierTests, /rejects a manifest with an incorrect size/);
assert.match(releaseVerifierDocs, /not publisher identity/);
assert.doesNotMatch(readme, /\\\\n- \[Phase 21/);
assert.match(readme, /\[Phase 21 task persistence and crash recovery\]\(docs\/phase-21-task-persistence-recovery\.md\)/);
assert.match(readme, /\[Phase 22 release-candidate acceptance\]\(docs\/phase-22-release-candidate-acceptance\.md\)/);
assert.match(workflow, /node --check "\$app\/app\/request-limiter\.mjs"/);
assert.match(workflow, /node --check \/tmp\/fnos-agent-ui-check\.mjs/);

assert.match(server, /executionEnabled: false/);
assert.doesNotMatch(server, /from\s+["']node:child_process["']/);
assert.doesNotMatch(server, /from\s+["']child_process["']/);
assert.doesNotMatch(server, /approval-ledger\.mjs/);
assert.match(server, /taskManager\.cancel\(/);
assert.match(server, /storageFile: dataDir \? join\(dataDir, "tasks\.json"\)/);
assert.match(server, /await taskManager\.ready/);
assert.match(server, /taskManager\.flush\(\)/);
assert.match(taskManager, /Never persist task inputs, prompts, results, or raw exception text/);
assert.match(taskManager, /服务重启导致任务中断/);
assert.match(taskManager, /rename\(temp, storageFile\)/);
assert.match(taskManager, /await chmod\(storageFile, 0o600\)/);
assert.match(auditLog, /maxBytes = 1_048_576/);
assert.match(taskPersistenceTests, /never auto-replayed/);
assert.match(taskPersistenceTests, /rejects corrupt state/);
assert.match(skills, /inspectSkillManifest\(buffer\)/);
assert.match(skills, /manifestReview: normalizeManifestReview\(input\.manifestReview\)/);
assert.match(archives, /MAX_ARCHIVE_BYTES = 5 \* 1024 \* 1024/);
assert.match(archives, /MAX_DECLARED_UNCOMPRESSED_BYTES = 20 \* 1024 \* 1024/);
assert.match(manifest, /MAX_MANIFEST_BYTES = MANIFEST_LIMIT/);
assert.match(ui, /textContent="静态清单："/);

const policy = createPermissionPolicy();
assert.equal(policy.evaluate({ risk: "read-only" }).allowed, true);
assert.equal(policy.evaluate({ risk: "write", approved: true }).allowed, false);
assert.equal(policy.evaluate({ risk: "destructive", approved: true }).allowed, false);
assert.equal(policy.snapshot().executionEnabled, false);

console.log("Release readiness gates passed: runtime dependency, CI matrix, packaging, and safety invariants.");

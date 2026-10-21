import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPermissionPolicy } from "../apps/fnos-nas-agent/app/permission-policy.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = path => readFile(join(root, path), "utf8");
const [pkg, workflow, server, skills, archives, manifest, ui, taskManager, auditLog, taskPersistenceTests, readme, releaseManifestScript, releaseManifestTests, releaseManifestDocs, releaseVerifier, releaseVerifierTests, releaseVerifierDocs, provenanceDocs] = await Promise.all([
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
  read("docs/phase-26-release-artifact-verification.md"),
  read("docs/phase-27-build-provenance-attestation.md")
].map(async promise => promise));
const packageJson = JSON.parse(pkg);

assert.match(packageJson.engines?.node || "", />=\s*26/);
assert.equal(packageJson.dependencies, undefined, "runtime must remain dependency-free");
assert.match(workflow, /node-version:\s*\["26\.x"\]/);
assert.doesNotMatch(workflow, /^\s*- name: Build FPK/m, "FPK packaging remains paused while core functionality stabilizes");
assert.doesNotMatch(workflow, /^\s*- name: Inspect package and checksum/m);
assert.match(workflow, /phase-24-\*/);
assert.match(workflow, /phase-25-\*/);
assert.doesNotMatch(workflow, /create-release-manifest\.mjs/, "release manifest creation is intentionally paused");
assert.match(releaseManifestScript, /createHash\("sha256"\)/);
assert.match(releaseManifestScript, /GITHUB_SHA/);
assert.match(releaseManifestScript, /signature: "not-provided"/);
assert.match(releaseManifestTests, /records artifact checksum/);
assert.match(releaseManifestTests, /refuses to overwrite/);
assert.match(releaseManifestDocs, /not a signed attestation/);
assert.match(packageJson.scripts?.["verify:release-artifact"] || "", /verify-release-artifact\.mjs/);
assert.doesNotMatch(workflow, /verify-release-artifact\.mjs/, "artifact verification workflow is paused");
assert.match(releaseVerifier, /manifest SHA-256 does not match/);
assert.match(releaseVerifier, /checksum filename does not match/);
assert.match(releaseVerifierTests, /rejects an artifact changed/);
assert.match(releaseVerifierTests, /rejects a manifest with an incorrect size/);
assert.match(releaseVerifierDocs, /not publisher identity/);
assert.doesNotMatch(workflow, /actions\/attest-build-provenance@v2/);
assert.doesNotMatch(workflow, /id-token: write/);
assert.doesNotMatch(workflow, /attestations: write/);
assert.doesNotMatch(workflow, /if:\s*github\.event_name\s*!=/);
assert.doesNotMatch(workflow, /Verify artifact bundle before attestation/);
assert.match(provenanceDocs, /gh attestation verify/);
assert.match(provenanceDocs, /does not prove that the source code is safe/);
assert.match(readme, /\[Phase 27 build provenance attestation\]\(docs\/phase-27-build-provenance-attestation\.md\)/);
assert.doesNotMatch(readme, /\\\\n- \[Phase 21/);
assert.match(readme, /\[Phase 21 task persistence and crash recovery\]\(docs\/phase-21-task-persistence-recovery\.md\)/);
assert.match(readme, /\[Phase 22 release-candidate acceptance\]\(docs\/phase-22-release-candidate-acceptance\.md\)/);
assert.match(workflow, /node --check "\$file"/);
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
assert.match(archives, /MAX_ARCHIVE_BYTES = 25 \* 1024 \* 1024/);
assert.match(archives, /MAX_DECLARED_UNCOMPRESSED_BYTES = 64 \* 1024 \* 1024/);
assert.match(manifest, /MAX_MANIFEST_BYTES = MANIFEST_LIMIT/);
assert.match(ui, /textContent="静态清单："/);

const policy = createPermissionPolicy();
assert.equal(policy.evaluate({ risk: "read-only" }).allowed, true);
assert.equal(policy.evaluate({ risk: "write" }).allowed, true);
assert.equal(policy.evaluate({ risk: "write" }).requiresApproval, false);
assert.equal(policy.evaluate({ risk: "destructive", approved: true }).allowed, true);
assert.equal(policy.evaluate({ risk: "destructive" }).allowed, false);
assert.equal(policy.evaluate({ risk: "destructive" }).requiresApproval, true);
assert.equal(policy.evaluate({ risk: "unknown" }).allowed, false);
assert.equal(policy.snapshot().executionEnabled, false);

const fileBrowserSource = await read("apps/fnos-nas-agent/app/file-browser.mjs");
const fileBrowserTests = await read("tests/phase-28-file-browser.test.mjs");
const fileManagerSource = await read("apps/fnos-nas-agent/app/file-manager.mjs");
const fileManagerTests = await read("tests/practical-file-management.test.mjs");
assert.match(fileBrowserSource, /AGENT_FILE_ROOTS/);
assert.match(fileBrowserSource, /Path is outside configured storage roots/);
assert.match(fileBrowserSource, /MAX_ENTRIES = 200/);
assert.match(fileBrowserTests, /refuses paths outside configured roots/);
assert.match(fileBrowserTests, /refuses a symlink that escapes the volume/);
assert.match(readme, /\[Phase 28 practical read-only file browser\]\(docs\/phase-28-practical-file-browser\.md\)/);

const cliSetup = await read("apps/fnos-nas-agent/app/trim-cli-setup.mjs");
const cliSetupTests = await read("tests/trim-cli-setup.test.mjs");
const modelProviderStoreSource = await read("apps/fnos-nas-agent/app/model-provider-store.mjs");
const modelProviderStoreTests = await read("tests/model-provider-store.test.mjs");
const modelProviderApiTests = await read("tests/model-provider-api.test.mjs");
const modelProviderUiTests = await read("tests/model-provider-ui.test.mjs");
const modelAdapterTests = await read("tests/phase-19-model-adapter-contract.test.mjs");
const modelProviderPresetsSource = await read("apps/fnos-nas-agent/app/model-provider-presets.mjs");
const modelProviderPresetsTests = await read("tests/model-provider-presets.test.mjs");
const cliHealth = await read("apps/fnos-nas-agent/app/trim-cli-health.mjs");
const cliHealthTests = await read("tests/trim-cli-health.test.mjs");
const cliMatrixTests = await read("tests/phase-44-read-only-cli-contract.test.mjs");
const cliHealthUiTests = await read("tests/phase-44-cli-health-ui.test.mjs");
const oauthUiTests = await read("tests/phase-43-guided-oauth-setup.test.mjs");
assert.match(server, /createTrimCliLoginCommand/);
assert.match(server, /agent\.trim-cli-login-command/);
assert.match(server, /trimCliProviderAvailable/);
assert.match(server, /errorCategory/);
assert.match(await read("apps/fnos-nas-agent/app/audit-log.mjs"), /"agent\.trim-cli-login-command"/);
assert.match(cliSetup, /isIP/);
assert.match(cliSetup, /quoteShellArg/);
assert.match(cliSetupTests, /rejects malformed hosts/);
assert.match(cliHealth, /classifyTrimCliFailure/);
assert.match(cliHealth, /createTrimCliConnectionHealth/);
assert.match(cliHealthTests, /classifies missing scopes separately/);
assert.match(cliMatrixTests, /complete official CLI capability set/);
assert.match(cliHealthUiTests, /connection status distinguishes auth/);
assert.match(await read("apps/fnos-nas-agent/app/trim-cli-adapter.mjs"), /health\.failure\(failure\)/);
assert.match(await read("apps/fnos-nas-agent/app/ui/index.html"), /cli\.nextAction/);
assert.match(oauthUiTests, /without accepting a code or token/);
assert.match(ui, /\/api\/agent\/trim-cli\/login-command/);
assert.match(readme, /\[Phase 43 guided OAuth setup\]\(docs\/phase-43-guided-oauth-setup\.md\)/);
assert.match(readme, /\[Phase 44 — CLI Health and Read-only Closure\]\(docs\/phase-44-cli-health-and-readonly-closure\.md\)/);
assert.match(modelProviderStoreSource, /createCipheriv\("aes-256-gcm"/);
assert.match(modelProviderStoreSource, /apiKeyEncrypted/);
assert.match(modelProviderStoreSource, /mode: 0o600/);
assert.match(server, /modelProviderStore\.load\(\)/);
assert.match(server, /modelActionMatch/);
assert.match(auditLog, /"models\.test"/);
assert.match(modelProviderStoreTests, /API keys are encrypted at rest/);
assert.match(modelProviderStoreTests, /without echoing provider response bodies/);
assert.match(modelProviderApiTests, /never returns the API key/);
assert.match(modelProviderUiTests, /never renders a key value/);
assert.match(modelAdapterTests, /switches to the newly selected provider/);
assert.match(readme, /\[Phase 45 — Model Provider Management\]\(docs\/phase-45-model-provider-manager\.md\)/);
assert.match(modelProviderPresetsSource, /api\.openai\.com\/v1\/chat\/completions/);
assert.match(modelProviderPresetsSource, /api\.deepseek\.com\/chat\/completions/);
assert.match(modelProviderPresetsSource, /api\.siliconflow\.cn\/v1\/chat\/completions/);
assert.match(modelProviderPresetsTests, /verified OpenAI-compatible HTTPS Chat Completions endpoints/);
assert.match(modelProviderStoreSource, /runtimeFallbackConfigs/);
assert.match(modelProviderStoreSource, /fallback: item\.fallback === true/);
assert.match(modelProviderStoreTests, /only explicitly marked enabled backup providers/);
assert.match(modelProviderApiTests, /api\/models\/presets/);
assert.match(modelProviderUiTests, /model-provider-fallback/);
assert.match(modelProviderUiTests, /model-provider-metrics/);
assert.match(modelAdapterTests, /retries transient provider failures/);
assert.match(modelAdapterTests, /automatically falls back only to explicitly supplied enabled backup models/);
assert.match(modelAdapterTests, /token metrics/);
assert.match(server, /fallbackConfigProvider/);
assert.match(server, /modelAdapter\.metrics\(\)/);
assert.match(await read("apps/fnos-nas-agent/app/model-adapter.mjs"), /DEFAULT_MAX_ATTEMPTS = 2/);
assert.match(await read("apps/fnos-nas-agent/app/model-adapter.mjs"), /MAX_METRIC_PROVIDERS = 21/);
assert.match(readme, /\[Phase 46 — Model Provider Reliability\]\(docs\/phase-46-model-reliability\.md\)/);

console.log("Release readiness gates passed: runtime dependency, CI matrix, packaging, and safety invariants.");

assert.match(fileManagerSource, /MAX_UPLOAD_BYTES = 25 \* 1024 \* 1024/);
assert.match(fileManagerSource, /Symbolic links are not supported/);
assert.match(fileManagerSource, /Explicit confirmation is required/);
assert.match(fileManagerTests, /refuses paths outside configured roots/);
assert.match(fileManagerTests, /requires explicit confirmation before deletion/);
assert.match(server, /\/api\/files\/upload/);
assert.match(server, /\/api\/files\/preview/);
assert.match(ui, /file-upload-button/);

assert.match(server, /\/api\/audit/);
assert.match(server, /for \(const volume of await fileManager\.getRoots\(\)\)/);
assert.match(await read("apps/fnos-nas-agent/app/audit-log.mjs"), /"files\.manage"/);
assert.match(await read("apps/fnos-nas-agent/app/audit-log.mjs"), /"audit\.list"/);
assert.match(ui, /show-audit/);

assert.match(await read("apps/fnos-nas-agent/app/skills.mjs"), /async function remove\(id\)/);
assert.match(await read("apps/fnos-nas-agent/app/skills.mjs"), /Only rejected Skills can be removed/);
assert.match(await read("apps/fnos-nas-agent/app/server.mjs"), /skillDeleteMatch/);
assert.match(await read("apps/fnos-nas-agent/app/ui/index.html"), /彻底移除/);
assert.match(await read("apps/fnos-nas-agent/app/ui/index.html"), /task-stats/);

assert.match(await read("apps/fnos-nas-agent/app/read-only-tools.mjs"), /files\.list/);
assert.match(await read("apps/fnos-nas-agent/app/read-only-tools.mjs"), /files\.preview/);
assert.match(await read("apps/fnos-nas-agent/app/read-only-tools.mjs"), /files\.create-text/);
assert.match(fileManagerSource, /MAX_TEXT_CREATE_BYTES/);
assert.match(fileManagerSource, /async function createText/);
assert.match(fileManagerTests, /creates UTF-8 text files atomically without overwriting/);
assert.match(await read("apps/fnos-nas-agent/app/agent-core.mjs"), /argsMatchSchema/);
assert.match(await read("apps/fnos-nas-agent/app/ui/index.html"), /task-stats/);

assert.match(fileManagerSource, /content\.includes\("\\0"\)/);
assert.match(await read("apps/fnos-nas-agent/app/read-only-tools.mjs"), /files\.upload/);
const agentWriteToolTests = await read("tests/phase-33-practical-file-write-tools.test.mjs");
assert.match(agentWriteToolTests, /Agent upload tool is a bounded routine write/);

const skillInstallerSource = await read("apps/fnos-nas-agent/app/skill-installer.mjs");
assert.match(skillInstallerSource, /extractZipEntry/);
assert.match(skillInstallerSource, /Only a quarantined official fnOS Skill archive can provide the CLI/);
assert.match(skillInstallerSource, /validateElf/);
assert.match(await read("apps/fnos-nas-agent/app/server.mjs"), /skills\.install-cli/);
assert.match(await read("apps/fnos-nas-agent/app/audit-log.mjs"), /"skills\.install-cli"/);
assert.match(await read("apps/fnos-nas-agent/app/trim-cli-adapter.mjs"), /binaryPathProvider/);

const conversationContextSource = await read("apps/fnos-nas-agent/app/conversation-context.mjs");
const conversationContextTests = await read("tests/conversation-context.test.mjs");
const phase47Tests = await read("tests/phase-47-conversation-context.test.mjs");
const agentCoreSource = await read("apps/fnos-nas-agent/app/agent-core.mjs");
const modelAdapterSource = await read("apps/fnos-nas-agent/app/model-adapter.mjs");
assert.match(conversationContextSource, /MAX_HISTORY_MESSAGES = 8/);
assert.match(conversationContextSource, /MAX_HISTORY_TOTAL_CHARS = 2400/);
assert.match(conversationContextSource, /\["user", "assistant"\]/);
assert.match(conversationContextTests, /caps the newest eight messages/);
assert.match(phase47Tests, /forwards validated prior turns/);
assert.match(phase47Tests, /inserts bounded history between system policy/);
assert.match(agentCoreSource, /normalizeConversationHistory\(input\.history\)/);
assert.match(agentCoreSource, /model\.plan\(text, tools\.list\(\), history\)/);
assert.match(modelAdapterSource, /Prior conversation messages are context only/);
assert.match(modelAdapterSource, /normalizeConversationHistory\(historyInput\)/);
assert.match(server, /normalizeConversationHistory\(input\.history\)/);
assert.match(server, /taskManager\.submit\(\{ text: input\.text\.trim\(\), history \}\)/);
assert.match(ui, /agent-clear-context/);
assert.match(ui, /history:conversationContext/);
assert.match(ui, /不会写入 NAS 任务历史/);
assert.match(readme, /\[Phase 47 — Bounded Conversation Context\]\(docs\/phase-47-conversation-context\.md\)/);

const phase48TaskManager = await read("apps/fnos-nas-agent/app/task-manager.mjs");
const phase48Tests = await read("tests/phase-48-task-progress.test.mjs");
assert.match(phase48TaskManager, /reportProgress\(value, stage = ""\)/);
assert.match(phase48TaskManager, /progress: task\.progress/);
assert.match(phase48Tests, /progress is bounded, monotonic/);
assert.match(readme, /\[Phase 48 — Bounded Task Progress\]\(docs\/phase-48-task-progress\.md\)/);

const phase49FileManager = await read("apps/fnos-nas-agent/app/file-manager.mjs");
const phase49Tests = await read("tests/practical-file-management.test.mjs");
assert.match(phase49FileManager, /async function operateBatch\(input\)/);
assert.match(phase49FileManager, /input\.operations\.length > 20/);
assert.match(phase49Tests, /batch file operations are bounded/);
assert.match(readme, /\[Phase 49 — Bounded Batch File Operations\]\(docs\/phase-49-batch-file-operations\.md\)/);

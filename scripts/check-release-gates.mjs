import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPermissionPolicy } from "../apps/fnos-nas-agent/app/permission-policy.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = path => readFile(join(root, path), "utf8");
const exists = async path => { try { await access(join(root, path)); return true; } catch { return false; } };
// A phase record that is still being delivered does not break the gate for
// every other phase: the missing file is reported and that phase is skipped.
const readOptional = async path => { try { return await read(path); } catch { return null; } };
// The user interface is split into an HTML shell, one stylesheet and two
// scripts. The gates read the same bundle the user interface tests read, so a
// contract that holds in the tests also holds in the release gates.
const readUiBundle = async () => {
  const html = await read("apps/fnos-nas-agent/app/ui/index.html");
  const directory = join(root, "apps/fnos-nas-agent/app/ui");
  const names = (await readdir(directory)).filter(name => name.endsWith(".js")).sort();
  const scripts = [];
  for (const name of names) scripts.push(await readFile(join(directory, name), "utf8"));
  return `<script>\n${scripts.join("\n")}\n</script>\n${html}`;
};
const [pkg, workflow, server, skills, archives, manifest, ui, taskManager, auditLog, taskPersistenceTests, readme, releaseManifestScript, releaseManifestTests, releaseManifestDocs, releaseVerifier, releaseVerifierTests, releaseVerifierDocs, provenanceDocs, phase116Docs, phase117Docs, lifecycleSmokeTests, fpkTestPlan, sessionCleanupTest, sessionCleanupDocs, phase123Docs, phase123WorkflowTest] = await Promise.all([
  read("package.json"),
  read(".github/workflows/build-fpk.yml"),
  read("apps/fnos-nas-agent/app/server.mjs"),
  read("apps/fnos-nas-agent/app/skills.mjs"),
  read("apps/fnos-nas-agent/app/skill-archives.mjs"),
  read("apps/fnos-nas-agent/app/skill-manifest.mjs"),
  readUiBundle(),
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
  read("docs/phase-27-build-provenance-attestation.md"),
  read("docs/phase-116-attestation-verification.md"),
  read("docs/phase-117-fpk-lifecycle-smoke.md"),
  read("tests/phase-117-fpk-lifecycle-smoke.test.mjs"),
  read("docs/fpk-test-plan.md"),
  read("tests/phase-119-expired-session-cleanup.test.mjs"),
  read("docs/phase-119-expired-session-cleanup.md"),
  read("docs/phase-123-fpk-bundled-runtime-smoke.md"),
  read("tests/phase-123-fpk-bundled-runtime-smoke.test.mjs")
].map(async promise => promise));
const packageJson = JSON.parse(pkg);

assert.match(packageJson.engines?.node || "", />=\s*26/);
assert.equal(packageJson.dependencies, undefined, "runtime must remain dependency-free");
assert.match(workflow, /node-version:\s*\["26\.x"\]/);
assert.match(workflow, /^\s*- name: Build FPK$/m);
assert.match(workflow, /- name: Smoke test bundled runtime and FPK lifecycle/);
assert.ok(workflow.indexOf("- name: Stage native FPK") < workflow.indexOf("- name: Smoke test bundled runtime and FPK lifecycle"));
assert.ok(workflow.indexOf("- name: Smoke test bundled runtime and FPK lifecycle") < workflow.indexOf("- name: Install verified fnpack"));
assert.match(workflow, /^\s*- name: Inspect package and checksum$/m);
assert.match(workflow, /fnpack-1\.2\.3-linux-amd64/);
assert.match(workflow, /fnpack_sha256="54b97fa7b70968c4d05c79840f5daeff508957d0bb2062fdb0376d00d9615c93"/);
assert.match(workflow, /sha256sum --check/);
assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4\.6\.2/);
assert.match(workflow, /retention-days: 14/);
assert.match(workflow, /phase-\*\/\*\*/);
assert.match(workflow, /"phase-\*-\*"/);
assert.match(workflow, /create-release-manifest\.mjs/);
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
const buildJobSource = workflow.split("\n  attest:\n")[0] || "";
const attestJobSource = workflow.split("\n  attest:\n")[1] || "";
assert.match(workflow, /\n  attest:\s*\n/);
assert.match(workflow, /if: github\.ref == 'refs\/heads\/main' && github\.event_name != 'pull_request'/);
assert.match(workflow, /\n    branches:\n      - main\n/);
assert.match(attestJobSource, /needs: build/);
assert.match(attestJobSource, /uses: actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4\.3\.0/);
assert.match(attestJobSource, /Verify artifact bundle before attestation/);
assert.match(attestJobSource, /verify-release-artifact\.mjs/);
assert.match(attestJobSource, /uses: actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4\.2\.2/);
assert.match(workflow, /uses: actions\/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5\.1\.0/);
assert.match(workflow, /uses: actions\/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5\.0\.0/);
assert.doesNotMatch(workflow, /uses:\s+actions\/(?:checkout|setup-node|upload-artifact|download-artifact|attest)@v\d/);
assert.match(attestJobSource, /subject-path: artifact\/fnos-nas-agent-test-node-26\.fpk/);
assert.match(attestJobSource, /Verify generated provenance attestation/);
assert.match(attestJobSource, /gh attestation verify/);
assert.match(attestJobSource, /GH_TOKEN: \$\{\{ github\.token \}\}/);
assert.match(attestJobSource, /--repo feng-fei\/fnos-nas-agent/);
assert.match(attestJobSource, /--signer-workflow feng-fei\/fnos-nas-agent\/\.github\/workflows\/build-fpk\.yml/);
assert.match(attestJobSource, /--source-ref refs\/heads\/main/);
assert.match(provenanceDocs, /does not prove that the source code is safe/);
assert.match(phase116Docs, /--signer-workflow/);
assert.match(phase116Docs, /--source-ref refs\/heads\/main/);
assert.match(phase117Docs, /start, status, and stop commands/);
assert.match(phase123Docs, /exact Node binary intended for the FPK/);
assert.match(phase123WorkflowTest, /staged bundled Node runtime before packaging/);
assert.match(readme, /\[Phase 123 — Bundled Runtime FPK Lifecycle Smoke\]\(docs\/phase-123-fpk-bundled-runtime-smoke\.md\)/);
assert.match(lifecycleSmokeTests, /start must be idempotent/);
assert.match(lifecycleSmokeTests, /stop must terminate the process/);
assert.match(fpkTestPlan, /launcher binds to `0\.0\.0\.0`/);
assert.doesNotMatch(fpkTestPlan, /LAN access remains disabled/);
assert.match(readme, /\[Phase 117 — FPK Lifecycle Smoke Verification\]\(docs\/phase-117-fpk-lifecycle-smoke\.md\)/);
assert.match(server, /void persistSessions\(\)\.catch\(\(\) => \{/);
assert.match(server, /Expired session cleanup could not be persisted\./);
assert.match(sessionCleanupTest, /expired-session persistence failures are handled and sanitized/);
assert.match(sessionCleanupDocs, /unhandled rejection/);
assert.match(readme, /\[Phase 119 — Expired Session Cleanup Error Handling\]\(docs\/phase-119-expired-session-cleanup\.md\)/);
assert.match(attestJobSource, /id-token: write/);
assert.match(attestJobSource, /attestations: write/);
assert.match(attestJobSource, /artifact-metadata: write/);
assert.doesNotMatch(buildJobSource, /id-token: write|attestations: write|artifact-metadata: write/);
assert.match(provenanceDocs, /gh attestation verify/);
assert.match(provenanceDocs, /does not prove that the source code is safe/);
assert.match(readme, /\[Phase 27 build provenance attestation\]\(docs\/phase-27-build-provenance-attestation\.md\)/);
assert.doesNotMatch(readme, /\\\\n- \[Phase 21/);
assert.match(readme, /\[Phase 21 task persistence and crash recovery\]\(docs\/phase-21-task-persistence-recovery\.md\)/);
assert.match(readme, /\[Phase 22 release-candidate acceptance\]\(docs\/phase-22-release-candidate-acceptance\.md\)/);
assert.match(readme, /\[Phase 112 — FPK CI Build and Artifact Verification\]\(docs\/phase-112-fpk-ci-build-and-artifact-verification\.md\)/);
assert.match(readme, /\[Phase 115 — Immutable GitHub Actions References\]\(docs\/phase-115-github-actions-pinning\.md\)/);
assert.match(readme, /\[Phase 116 — Post-signing Attestation Verification\]\(docs\/phase-116-attestation-verification\.md\)/);
assert.match(readme, /GitHub Actions builds an unsigned x86 CI test FPK/);
assert.match(workflow, /node --check "\$file"/);
assert.match(workflow, /find "\$app\/app\/ui" -type f -name '\*\.js' -print0/);
assert.match(workflow, /the UI shell must not carry an inline script/);
assert.match(workflow, /test -s "\$stage\/app\/ui\/core\.js"/);
assert.match(workflow, /test -s "\$stage\/app\/ui\/styles\.css"/);
assert.doesNotMatch(workflow, /fnos-agent-ui-check\.mjs/);

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
assert.match(ui, /cli\.nextAction/);
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

assert.match(fileManagerSource, /MAX_UPLOAD_BYTES = 25 \* 1024 \* 1024/);
assert.match(fileManagerSource, /Symbolic links are not supported/);
assert.match(fileManagerSource, /Explicit confirmation is required/);
assert.match(fileManagerTests, /refuses paths outside configured roots/);
assert.match(fileManagerTests, /requires the server-side delete capability/);
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
assert.match(ui, /彻底移除/);
assert.match(ui, /task-stats/);

assert.match(await read("apps/fnos-nas-agent/app/read-only-tools.mjs"), /files\.list/);
assert.match(await read("apps/fnos-nas-agent/app/read-only-tools.mjs"), /files\.preview/);
assert.match(await read("apps/fnos-nas-agent/app/read-only-tools.mjs"), /files\.create-text/);
assert.match(fileManagerSource, /MAX_TEXT_CREATE_BYTES/);
assert.match(fileManagerSource, /async function createText/);
assert.match(fileManagerTests, /creates UTF-8 text files atomically without overwriting/);
assert.match(await read("apps/fnos-nas-agent/app/agent-core.mjs"), /argsMatchSchema/);
assert.match(ui, /task-stats/);

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
assert.match(agentCoreSource, /model\.plan\(text, tools\.list\(\), history/);
assert.match(agentCoreSource, /const cancelled = \(\) => shouldCancel\(\) \|\| Boolean\(signal && signal\.aborted\);/);
assert.match(taskManager, /awaiting-approval/);
assert.match(modelAdapterSource, /Prior conversation messages are context only/);
assert.match(modelAdapterSource, /normalizeConversationHistory\(historyInput\)/);
assert.match(server, /normalizeConversationHistory\(input\.history\)/);
assert.match(server, /taskManager\.submit\(\{ text: input\.text\.trim\(\), history \}, \{ sessionId: active\.key \}\)/);
assert.match(ui, /agent-clear-context/);
assert.match(ui, /history:conversationContext/);
assert.match(ui, /不会写入 NAS 任务历史/);
assert.match(readme, /\[Phase 47 — Bounded Conversation Context\]\(docs\/phase-47-conversation-context\.md\)/);

// Phase 126/127/131: the execution policy is the single gate for every mutating path.
const executionPolicySource = await read("apps/fnos-nas-agent/app/execution-policy.mjs");
const executionCapabilitySource = await read("apps/fnos-nas-agent/app/execution-capability.mjs");
assert.match(executionPolicySource, /export const EXECUTION_MODES = Object\.freeze\(\["normal", "read-only", "halted"\]\)/);
assert.match(executionPolicySource, /export function createExecutionPolicy\(/);
assert.match(executionPolicySource, /kill-switch/);
assert.match(executionPolicySource, /read-only-mode/);
assert.match(executionCapabilitySource, /export const DELETE_CAPABILITY = Symbol\(/);
assert.match(executionCapabilitySource, /export function hasDeleteCapability\(/);
assert.doesNotMatch(executionCapabilitySource, /Symbol\.for\(/);
assert.match(server, /executionPolicy\.evaluate\(/);
assert.match(server, /isLoopbackRequest\(req\)/);
assert.match(server, /setupCodeMatches\(body\.code\)/);
assert.match(server, /actionApprovals\.list\(active\.key\)/);
assert.match(server, /actionApprovals\.confirm\(actionId, active\.key\)/);
assert.match(server, /toolRunLimiter/);
assert.match(server, /agentMessageLimiter/);
assert.match(server, /process\.on\("uncaughtException"/);
assert.match(server, /url\.pathname === "\/api\/execution-mode"/);
assert.match(server, /executionPolicy\.setMode\(/);
assert.match(await read("apps/fnos-nas-agent/app/audit-log.mjs"), /"files\.checksum"/);
assert.match(readme, /\[Phase 126 — Execution Policy\]\(docs\/phase-126-execution-policy\.md\)/);
assert.match(readme, /\[Phase 127 — Destructive Capability\]\(docs\/phase-127-destructive-capability\.md\)/);
assert.match(readme, /\[Phase 131 — Server Hardening\]\(docs\/phase-131-server-hardening\.md\)/);
assert.match(readme, /\[Phase 132 — Real NAS Staging Acceptance\]\(docs\/phase-132-nas-staging-acceptance\.md\)/);
assert.match(readme, /\[Phase 133 — Model Fallback and Scan Bounds\]\(docs\/phase-133-model-fallback-and-scan-bounds\.md\)/);
assert.ok(await exists("docs/phase-133-model-fallback-and-scan-bounds.md"), "The model fallback and scan bound record must exist.");
assert.match(await read("apps/fnos-nas-agent/app/permission-policy.mjs"), /createExecutionPolicy \} from "\.\/execution-policy\.mjs"/);
assert.match(await read("apps/fnos-nas-agent/app/file-browser.mjs"), /MAX_SCAN_ENTRIES = 2000/);
assert.match(readme, /MIT License/);
assert.match(readme, /\[LICENSE\]\(LICENSE\)/);
assert.ok(await exists("LICENSE"), "LICENSE must exist before a release is published.");
assert.ok(await exists("apps/fnos-nas-agent/app/version.mjs"), "The shared version module must exist.");
assert.ok(await exists("docs/phase-132-nas-staging-acceptance.md"), "The NAS staging acceptance record must exist.");
assert.match(await read("apps/fnos-nas-agent/app/version.mjs"), /export const APP_VERSION = "0\.2\.1"/);
assert.match(await read("apps/fnos-nas-agent/manifest"), /version\s+=\s+0\.2\.1/);
assert.match(pkg, /"version": "0\.2\.1"/);
assert.match(pkg, /"license": "MIT"/);

// Phase 134: the overview service turns six API calls into one.
const overviewSource = await read("apps/fnos-nas-agent/app/overview.mjs");
assert.match(overviewSource, /export function createOverviewService\(/);
assert.match(overviewSource, /snapshot\(\)/);
assert.match(server, /createOverviewService\(/);
assert.match(server, /url\.pathname === "\/api\/overview"/);
assert.match(server, /overviewService\.snapshot\(\)/);
assert.ok(await exists("tests/phase-134-overview-service.test.mjs"), "The overview service test must exist.");
assert.ok(await exists("docs/phase-134-overview-service.md"), "The overview service record must exist.");
assert.match(readme, /\[Phase 134 — Overview Service\]\(docs\/phase-134-overview-service\.md\)/);

// Phase 135: the user interface is a static shell plus one stylesheet and two
// scripts, and the server serves them as real assets.
assert.ok(await exists("apps/fnos-nas-agent/app/ui/styles.css"), "The design system stylesheet must exist.");
assert.ok(await exists("apps/fnos-nas-agent/app/ui/core.js"), "The user interface core script must exist.");
assert.ok(await exists("apps/fnos-nas-agent/app/ui/pages.js"), "The user interface page script must exist.");
assert.match(ui, /<link[^>]+href="\/ui\/styles\.css"/);
assert.match(ui, /<script src="\/ui\/core\.js"><\/script>/);
assert.match(ui, /<script src="\/ui\/pages\.js"><\/script>/);
assert.match(server, /serveUiAsset\(/);
assert.match(server, /UI_ASSET_TYPES/);
assert.ok(await exists("tests/phase-135-mobile-first-user-interface.test.mjs"), "The user interface contract test must exist.");
assert.ok(await exists("docs/phase-135-mobile-first-user-interface.md"), "The user interface record must exist.");
assert.match(readme, /\[Phase 135 — Mobile First User Interface\]\(docs\/phase-135-mobile-first-user-interface\.md\)/);

// Phase 136: the Skill domain no longer accepts a client-declared review
// verdict. The server reviews the quarantined archive itself, the inventory
// refuses duplicate names, an approval and an official CLI installation both
// require a server-owned review, unscanned archive entries are reported as
// findings, and the batch download budget is charged for failed downloads.
const phase136Skills = await read("apps/fnos-nas-agent/app/skills.mjs");
const phase136Installer = await read("apps/fnos-nas-agent/app/skill-installer.mjs");
const phase136SourceReview = await read("apps/fnos-nas-agent/app/skill-source-review.mjs");
const phase136Batch = await read("apps/fnos-nas-agent/app/skill-remote-import-batch.mjs");
const phase136RemoteImport = await read("apps/fnos-nas-agent/app/skill-remote-import.mjs");
const phase136Tests = await read("tests/phase-136-skill-trust-hardening.test.mjs");
const phase136Docs = await read("docs/phase-136-skill-trust-hardening.md");
const phase136DocsIndex = await read("docs/README.md");
assert.match(phase136Skills, /readQuarantinedArchiveForReview/);
assert.match(phase136Skills, /const quarantineFile = "skill-quarantine\/" \+ archiveSha256 \+ "\.zip";/);
assert.match(phase136Skills, /A quarantined Skill archive is required to register a Skill/);
assert.match(phase136Skills, /Skill name already registered/);
assert.match(phase136Skills, /A server-side static review is required before approving this Skill/);
assert.match(phase136Skills, /reviewedBy: "server"/);
assert.match(phase136Skills, /\^\[a-f0-9\]\{64\}\$/);
assert.match(phase136Installer, /The Skill was not reviewed by the server; re-import the archive before installing its CLI/);
assert.match(phase136Installer, /Official fnOS CLI binary entry is missing from the archive/);
assert.match(phase136Installer, /reviewedBy: "server"/);
assert.match(phase136SourceReview, /unreviewed-binary-entry: /);
assert.match(phase136SourceReview, /needs_review/);
assert.match(phase136Batch, /readTransferredBytes/);
assert.match(phase136Batch, /isReadStageError/);
assert.match(phase136Batch, /startsWith\("SKILL_REMOTE_"\)/);
assert.match(phase136RemoteImport, /export function normalizeRepositoryName\(owner, repo\)/);
assert.match(phase136RemoteImport, /repo\.replace\(\/\\\.git\$\/i, ""\)/);
assert.ok(await exists("tests/phase-136-skill-trust-hardening.test.mjs"), "The Skill trust hardening test must exist.");
assert.ok(await exists("docs/phase-136-skill-trust-hardening.md"), "The Skill trust hardening record must exist.");
assert.match(readme, /\[Phase 136 — Skill Trust Hardening\]\(docs\/phase-136-skill-trust-hardening\.md\)/);
const docsIndexEntries = (await readdir(join(root, "docs"))).filter(name => name.endsWith(".md") && name !== "README.md");
const docsIndexPhaseCount = docsIndexEntries.filter(name => /^phase-\d+/.test(name)).length;
const docsIndexOtherCount = docsIndexEntries.length - docsIndexPhaseCount;
const docsIndexTotalCount = docsIndexEntries.length + 1;
assert.match(phase136DocsIndex, new RegExp("This index lists " + docsIndexTotalCount + " documents \\(" + docsIndexPhaseCount + " phase documents and " + docsIndexOtherCount + " non-phase documents, plus this file\\)\\."));
assert.match(phase136DocsIndex, /### Phase 136/);
assert.match(phase136Tests, /quarantined Skill archive is required/i);
assert.match(phase136Tests, /not reviewed by the server/i);
assert.match(phase136Tests, /unreviewed-binary-entry/);
assert.match(phase136Docs, /Threat model/);
assert.match(phase136Docs, /no signature verification|no publisher/);

// Phase 137: an approval and the task it belongs to are one lifecycle now.
// "awaiting-approval" is not a terminal state, a confirmed or denied action
// resolves its task, and task history is scoped to the calling session.
const phase137TaskManager = await read("apps/fnos-nas-agent/app/task-manager.mjs");
const phase137Approvals = await read("apps/fnos-nas-agent/app/action-approval-service.mjs");
const phase137AgentCore = await read("apps/fnos-nas-agent/app/agent-core.mjs");
const phase137Tests = await read("tests/phase-137-task-approval-lifecycle.test.mjs");
const phase137Docs = await read("docs/phase-137-task-approval-lifecycle.md");
assert.match(phase137TaskManager, /awaiting-approval/);
assert.match(phase137TaskManager, /resolveApproval\(taskId/);
assert.match(phase137TaskManager, /ownsTask/);
assert.match(phase137Approvals, /revoke\(idValue, sessionId/);
assert.match(phase137Approvals, /revokeTask\(taskId/);
assert.match(phase137Approvals, /The pending action belongs to another session/);
assert.match(phase137AgentCore, /context\?\.taskId/);
assert.match(server, /taskManager\.resolveApproval\(/);
assert.match(server, /actionApprovals\.revokeTask\(/);
assert.match(server, /taskManager\.clearTerminal\(active\.key\)/);
assert.ok(await exists("tests/phase-137-task-approval-lifecycle.test.mjs"), "The task and approval lifecycle test must exist.");
assert.ok(await exists("docs/phase-137-task-approval-lifecycle.md"), "The task and approval lifecycle record must exist.");
assert.match(readme, /\[Phase 137 — Task and Approval Lifecycle\]\(docs\/phase-137-task-approval-lifecycle\.md\)/);
assert.match(phase136DocsIndex, /### Phase 137/);
assert.match(phase137Tests, /awaiting-approval/);
assert.match(phase137Docs, /awaiting-approval/);

// Phase 139: the environment template states the real defaults, and a
// TLS-terminating reverse proxy is documented instead of silently breaking
// every write request.
const phase139Env = await read(".env.example");
const phase139Security = await read("docs/security.md");
const phase139Deploy = await read("docs/phase-139-reverse-proxy-deployment.md");
const phase139Tests = await read("tests/phase-139-environment-and-proxy-docs.test.mjs");
assert.match(phase139Env, /AGENT_TRUST_PROXY=0/);
assert.match(phase139Env, /AGENT_TASK_TIMEOUT_MS=300000/);
assert.match(phase139Env, /AGENT_EXECUTION_MODE=normal/);
assert.match(phase139Env, /HOST=0\.0\.0\.0/);
assert.match(phase139Env, /PORT=18787/);
assert.doesNotMatch(phase139Env, /AGENT_ACCESS_TOKEN/);
assert.match(server, /AGENT_TRUST_PROXY/);
assert.match(server, /function externalOrigin\(/);
assert.match(phase139Security, /反向代理与 TLS 终止/);
assert.match(phase139Security, /AGENT_TRUST_PROXY/);
assert.ok(await exists("tests/phase-139-environment-and-proxy-docs.test.mjs"), "The environment and proxy documentation test must exist.");
assert.ok(await exists("docs/phase-139-reverse-proxy-deployment.md"), "The reverse proxy deployment record must exist.");
assert.match(readme, /\[Phase 139 — Reverse Proxy Deployment\]\(docs\/phase-139-reverse-proxy-deployment\.md\)/);
assert.match(phase136DocsIndex, /### Phase 139/);
assert.match(phase139Deploy, /X-Forwarded-Proto/);
assert.match(phase139Tests, /AGENT_TRUST_PROXY/);

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

/* ---------------------------------------------- Phase 138 assertions -- */
const phase138Browser = await read("apps/fnos-nas-agent/app/file-browser.mjs");
const phase138Manager = await read("apps/fnos-nas-agent/app/file-manager.mjs");
const phase138Tools = await read("apps/fnos-nas-agent/app/read-only-tools.mjs");
const phase138Trim = await read("apps/fnos-nas-agent/app/trim-cli-adapter.mjs");
const phase138Tests = await read("tests/phase-138-file-domain-hardening.test.mjs");
const phase138Docs = await read("docs/phase-138-file-domain-hardening.md");
assert.match(phase138Browser, /export function compareRootPaths/);
assert.match(phase138Browser, /export function summarizeDirectoryEntries/);
assert.match(phase138Browser, /Symbolic links are not supported/);
assert.match(phase138Manager, /export async function publishStagedFile/);
assert.match(phase138Manager, /"hard-link"/);
assert.match(phase138Manager, /"atomic-rename"/);
assert.match(phase138Manager, /Symbolic links are not supported/);
assert.match(phase138Tools, /export function decodeUploadPayload/);
assert.match(phase138Tools, /MAX_UPLOAD_BASE64_CHARS/);
assert.match(phase138Trim, /health\.success\(id\)/);
assert.match(phase138Tests, /publishStagedFile/);
assert.match(phase138Docs, /symlink|symbolic link/i);
assert.match(phase136DocsIndex, /### Phase 138/);
assert.match(readme, /Phase 138 — File Domain Hardening/);

/* ---------------------------------------------- Phase 140 assertions -- */
const phase140Adapter = await read("apps/fnos-nas-agent/app/model-adapter.mjs");
const phase140Store = await read("apps/fnos-nas-agent/app/model-provider-store.mjs");
const phase140Tests = await read("tests/phase-140-model-provider-resilience.test.mjs");
const phase140Docs = await read("docs/phase-140-model-provider-resilience.md");
assert.match(phase140Adapter, /MODEL_REQUEST_ABORTED/);
assert.match(phase140Adapter, /AbortSignal\.any\(/);
assert.match(phase140Adapter, /fallbackEligible/);
assert.match(phase140Adapter, /httpAttempts/);
assert.match(phase140Adapter, /wallClockLatencyMs/);
assert.match(phase140Store, /runtimeConfig/);
assert.match(phase140Tests, /MODEL_REQUEST_ABORTED|runtimeConfig/);
assert.match(phase140Docs, /fallback/i);
assert.match(phase136DocsIndex, /### Phase 140/);
assert.match(readme, /Phase 140 — Model Provider Resilience/);


/* ---------------------------------------------- Phase 141 assertions -- */
// The official fnOS package is identified by the server side review of the
// archive, never by the name the operator typed when registering it.
const phase141Package = await read("apps/fnos-nas-agent/app/skill-official-package.mjs");
const phase141Installer = await read("apps/fnos-nas-agent/app/skill-installer.mjs");
const phase141Tests = await read("tests/phase-141-official-skill-identity.test.mjs");
const phase141Docs = await read("docs/phase-141-official-skill-identity.md");
assert.match(phase141Package, /export function isOfficialFnosPackage/);
assert.match(phase141Package, /reviewedBy/);
assert.match(phase141Package, /archiveSha256/);
assert.match(phase141Package, /skill-quarantine/);
assert.match(phase141Installer, /import \{ isOfficialFnosPackage \} from "\.\/skill-official-package\.mjs";/);
assert.match(phase141Installer, /if \(!isOfficialFnosPackage\(record\)\)/);
assert.doesNotMatch(phase141Installer, /record\.name\.toLowerCase\(\) !== "fnos"/);
assert.match(server, /import \{ isOfficialFnosPackage \} from "\.\/skill-official-package\.mjs";/);
assert.match(server, /enabled\.find\(item => isOfficialFnosPackage\(item\)\)/);
assert.match(ui, /const officialPackage=item\.manifestReview\?\.reviewedBy==="server"/);
assert.doesNotMatch(ui, /item\.name\?\.toLowerCase\(\)==="fnos"/);
assert.match(phase141Tests, /isOfficialFnosPackage/);
assert.match(phase141Docs, /reviewedBy|server side review/i);
assert.match(phase136DocsIndex, /### Phase 141/);
assert.match(readme, /Phase 141 — Official Skill Identity/);


/* ---------------------------------------------- Phase 142 assertions -- */
// The official package declares its binaries relative to the package
// root, so the declaration is resolved before it is compared with the
// archive entry that the current platform expects.
const phase142Installer = await read("apps/fnos-nas-agent/app/skill-installer.mjs");
const phase142Tests = await read("tests/phase-142-official-cli-manifest-paths.test.mjs");
const phase142Docs = await read("docs/phase-142-official-cli-manifest-paths.md");
assert.match(phase142Installer, /export function resolveManifestEntry/);
assert.match(phase142Installer, /resolveManifestEntry\(manifest, target\.key\) !== target\.entry/);
assert.doesNotMatch(phase142Installer, /manifest\.bin\?\.\[target\.key\] !== target\.entry/);
assert.match(phase142Tests, /resolveManifestEntry/);
assert.match(phase142Docs, /manifest/i);
assert.match(phase136DocsIndex, /### Phase 142/);
assert.match(readme, /Phase 142 — Official CLI Manifest Paths/);

/* ---------------------------------------------- Phase 143 assertions -- */
// The official CLI reports a profile that was never logged in with a
// plain "run login first". That first-run answer must be classified as
// a missing login, not as an unexpected server error.
const phase143Health = await read("apps/fnos-nas-agent/app/trim-cli-health.mjs");
const phase143Tests = await read("tests/phase-143-cli-login-required.test.mjs");
const phase143Docs = await read("docs/phase-143-cli-login-required.md");
assert.match(phase143Health, /kind: "login_required"/);
assert.match(phase143Health, /session is required/);
assert.match(phase143Health, /kind = "login_required"/);
assert.match(phase143Tests, /login_required/);
assert.match(phase143Docs, /login/i);
assert.match(phase136DocsIndex, /### Phase 143/);
assert.match(readme, /Phase 143 — Official CLI Login Guidance/);

/* ---------------------------------------------- Phase 144-151 assertions -- */
// The Marvis migration added a Skill package parser, a shared rule pack for
// dangerous commands, a registrable tool registry, an MCP client, a tool
// trace, a conversation window, a chat adapter and a direct chat route.
// Every one of them has to stay documented, indexed and linked from the
// README, otherwise the next release silently loses the design record.
const phase144Docs = await read("docs/phase-144-skill-package-format.md");
const phase145Docs = await readOptional("docs/phase-145-dangerous-command-rules.md");
const phase146TraceDocs = await read("docs/phase-146-tool-trace.md");
const phase146EventsDocs = await read("docs/phase-146-task-events.md");
const phase147Docs = await read("docs/phase-147-tool-registry.md");
const phase148Docs = await read("docs/phase-148-mcp-client.md");
const phase149Docs = await read("docs/phase-149-chat-window.md");
const phase150Docs = await read("docs/phase-150-model-chat-adapter.md");
const phase151Docs = await read("docs/phase-151-direct-chat-http.md");
const phase144Tests = await read("tests/phase-144-skill-package-format.test.mjs");
const phase145Tests = await read("tests/phase-145-dangerous-command-rules.test.mjs");
const phase146TraceTests = await read("tests/phase-146-tool-trace.test.mjs");
const phase146EventsTests = await read("tests/phase-146-task-events.test.mjs");
const phase147Tests = await read("tests/phase-147-tool-registry.test.mjs");
const phase148Tests = await read("tests/phase-148-mcp-client.test.mjs");
const phase149Tests = await read("tests/phase-149-chat-window.test.mjs");
const phase150Tests = await read("tests/phase-150-model-chat-adapter.test.mjs");
const phase151Tests = await read("tests/phase-151-chat-http.test.mjs");
const phase144Parser = await read("apps/fnos-nas-agent/app/skill-package.mjs");
const phase145Rules = await read("apps/fnos-nas-agent/app/dangerous-command-rules.mjs");
const phase147Registry = await read("apps/fnos-nas-agent/app/tool-registry.mjs");
const phase148Client = await read("apps/fnos-nas-agent/app/mcp-client.mjs");
const phase151Adapter = await read("apps/fnos-nas-agent/app/model-chat-adapter.mjs");
assert.match(phase144Parser, /export function parseSkillPackage/);
assert.match(phase144Tests, /parseSkillPackage/);
assert.match(phase144Docs, /Skill/i);
assert.match(phase145Rules, /DANGEROUS_COMMAND_RULES/);
assert.match(phase145Tests, /dangerous/i);
if (phase145Docs) {
  assert.match(phase145Docs, /dangerous/i);
} else {
  console.log("Release gates: docs/phase-145-dangerous-command-rules.md is not written yet, its content check is skipped.");
}
assert.match(phase146TraceDocs, /trace/i);
assert.match(phase146TraceTests, /trace/i);
assert.match(phase146EventsDocs, /event/i);
assert.match(phase146EventsTests, /subscribe/i);
assert.match(phase147Registry, /export function createToolRegistry/);
assert.match(phase147Tests, /createToolRegistry/);
assert.match(phase147Docs, /registry/i);
assert.match(phase148Client, /MCP_PROTOCOL_VERSION/);
assert.match(phase148Tests, /mcp/i);
assert.match(phase148Docs, /MCP/i);
assert.match(phase149Tests, /chat/i);
assert.match(phase149Docs, /conversation/i);
assert.match(phase150Tests, /chat/i);
assert.match(phase150Docs, /adapter/i);
assert.match(phase151Adapter, /MODEL_CHAT_/);
assert.match(phase151Tests, /chat/i);
assert.match(phase151Docs, /chat/i);
assert.match(phase136DocsIndex, /### Phase 144/);
assert.match(phase136DocsIndex, /### Phase 145/);
assert.match(phase136DocsIndex, /### Phase 146/);
assert.match(phase136DocsIndex, /### Phase 147/);
assert.match(phase136DocsIndex, /### Phase 148/);
assert.match(phase136DocsIndex, /### Phase 149/);
assert.match(phase136DocsIndex, /### Phase 150/);
assert.match(phase136DocsIndex, /### Phase 151/);
assert.match(readme, /Phase 144 — Skill Package Format/);
assert.match(readme, /Phase 145 — Dangerous Command Rule Pack/);
assert.match(readme, /Phase 146 — Tool Call Observability/);
assert.match(readme, /Phase 146 — Task Event Stream/);
assert.match(readme, /Phase 147 — Registrable Tool Registry/);
assert.match(readme, /Phase 148 — MCP Client/);
assert.match(readme, /Phase 149 — Marvis Style Conversation Window/);
assert.match(readme, /Phase 150 — Model Chat Adapter/);
assert.match(readme, /Phase 151 — Direct Chat Channel over HTTP/);

/* ---------------------- Phase 151 (dual mode) and Phase 152+ assertions -- */
// The conversation window gained a second, direct mode under the same phase
// number, and the phases after 151 are still being delivered by the other
// authors. A phase whose record is not written yet is reported and skipped,
// so one unfinished phase does not hide the state of the rest.
const phase151ModeDocs = await readOptional("docs/phase-151-chat-direct-mode.md");
const phase151ModeTests = await readOptional("tests/phase-151-chat-direct-mode.test.mjs");
if (phase151ModeDocs && phase151ModeTests) {
  assert.match(phase151ModeDocs, /chat/i);
  assert.match(phase151ModeTests, /chat/i);
  assert.match(phase136DocsIndex, /### Phase 151/);
  assert.match(phase136DocsIndex, /\]\(phase-151-chat-direct-mode\.md\)/);
  assert.match(readme, /Phase 151 — Dual-mode Chat Window/);
  assert.match(readme, /docs\/phase-151-chat-direct-mode\.md/);
} else {
  console.log("Release gates: the Phase 151 dual-mode chat window record is not written yet, its content check is skipped.");
}

// Every phase record from 152 onwards has to be indexed and linked from the
// README, exactly like the records before it. The phase number is taken from
// the file name, so a record is never allowed to sit in the directory
// without a place in the documentation. The titles that are already known
// are checked word for word.
const laterPhaseTitles = new Map([
  [153, "Phase 153 — MCP Tool Bridge"],
  [154, "Phase 154 — Model Settings UI"],
  [155, "Phase 155 — Tool Call Observer"]
]);
const laterPhaseRecords = (await readdir(join(root, "docs")))
  .filter(name => /^phase-15[2-9]-.*\.md$/.test(name))
  .sort();
for (const name of laterPhaseRecords) {
  const phaseNumber = Number(name.match(/^phase-(\d+)/)[1]);
  const phaseDoc = await read(`docs/${name}`);
  const phaseTestPath = `tests/${name.replace(/\.md$/, ".test.mjs")}`;
  if (!(await exists(phaseTestPath))) {
    console.log(`Release gates: ${name} has no test file (${phaseTestPath}) yet, its content check is skipped.`);
  } else {
    const phaseTest = await read(phaseTestPath);
    assert.match(phaseDoc, /\S/);
    assert.match(phaseTest, /\S/);
  }
  assert.match(phase136DocsIndex, new RegExp(`### Phase ${phaseNumber}`));
  assert.match(phase136DocsIndex, new RegExp(`\\]\\(${name}\\)`));
  assert.match(readme, new RegExp(`docs/${name.replace(/\./g, "\\.")}`));
  const knownTitle = laterPhaseTitles.get(phaseNumber);
  if (knownTitle) {
    assert.match(readme, new RegExp(knownTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  console.log(`Release gates: Phase ${phaseNumber} record ${name} is indexed and linked.`);
}

console.log("Release readiness gates passed: runtime dependency, CI matrix, packaging, and safety invariants.");

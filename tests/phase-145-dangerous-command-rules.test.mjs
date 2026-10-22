import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  DANGEROUS_COMMAND_RULES,
  DANGEROUS_COMMAND_LANGUAGES,
  DANGEROUS_COMMAND_SEVERITIES,
  DANGEROUS_COMMAND_SEVERITY_ORDER,
  DANGEROUS_COMMAND_SHELLS,
  SOURCE_REVIEW_COMMAND_RULES,
  MANIFEST_COMMAND_RULES,
  COMMAND_RULES,
  findDangerousCommandRule,
  languageForShell
} from "../apps/fnos-nas-agent/app/dangerous-command-rules.mjs";

import {
  scanCommand,
  scanText
} from "../apps/fnos-nas-agent/app/command-safety-scanner.mjs";

const APP_DIR = new URL("../apps/fnos-nas-agent/app/", import.meta.url);

const readAppSource = name => readFile(fileURLToPath(new URL(name, APP_DIR)), "utf8");

const HISTORICAL_SOURCE_REVIEW_IDS = [
  "shell-execution-api",
  "dynamic-code-evaluation",
  "download-piped-to-shell",
  "privilege-escalation-command",
  "destructive-system-command",
  "credential-or-private-key-path",
  "private-key-material",
  "cloud-access-key-id",
  "github-token-pattern",
  "hardcoded-secret-assignment",
  "package-registry-token"
];

const HISTORICAL_MANIFEST_IDS = [
  "potentially-dangerous-command-text",
  "execution-related-text"
];

test("rule pack exposes a frozen, non-empty catalogue", () => {
  assert.ok(Array.isArray(DANGEROUS_COMMAND_RULES));
  assert.ok(DANGEROUS_COMMAND_RULES.length >= 13);
  assert.ok(Object.isFrozen(DANGEROUS_COMMAND_RULES));
});

test("every rule carries the documented shape", () => {
  for (const rule of DANGEROUS_COMMAND_RULES) {
    assert.equal(typeof rule.id, "string", `rule ${rule.id} has no id`);
    assert.ok(rule.id.length > 0);
    assert.ok(DANGEROUS_COMMAND_SEVERITIES.includes(rule.severity), `${rule.id} severity ${rule.severity}`);
    assert.ok(Array.isArray(rule.languages) && rule.languages.length > 0, `${rule.id} has no languages`);
    for (const language of rule.languages) {
      assert.ok(DANGEROUS_COMMAND_LANGUAGES.includes(language), `${rule.id} uses unknown language ${language}`);
    }
    assert.ok(DANGEROUS_COMMAND_SHELLS.includes(rule.shell), `${rule.id} uses unknown shell ${rule.shell}`);
    assert.ok(typeof rule.title === "string" && rule.title.length > 0, `${rule.id} has no title`);
    assert.ok(typeof rule.description === "string" && rule.description.length > 0, `${rule.id} has no description`);
    assert.ok(typeof rule.message === "string" && rule.message.length > 0, `${rule.id} has no message`);
    assert.ok(rule.pattern instanceof RegExp, `${rule.id} has no compiled pattern`);
    assert.equal(typeof rule.patternSource, "string", `${rule.id} has no pattern source`);
    assert.equal(rule.pattern.source, rule.patternSource, `${rule.id} pattern source drifted`);
  }
});

test("rule identifiers are unique and resolvable", () => {
  const ids = DANGEROUS_COMMAND_RULES.map(rule => rule.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate rule id in the pack");
  for (const id of ids) {
    assert.equal(findDangerousCommandRule(id).id, id);
  }
  assert.equal(findDangerousCommandRule("no-such-rule"), null);
});

test("languages and severities are the documented enumerations", () => {
  assert.deepEqual([...DANGEROUS_COMMAND_LANGUAGES], ["shell", "powershell", "python", "node"]);
  assert.deepEqual([...DANGEROUS_COMMAND_SEVERITIES], ["block", "warn", "review", "info"]);
  assert.deepEqual([...DANGEROUS_COMMAND_SHELLS], ["bash", "pwsh", "python", "node"]);
});

test("severity ordering is strict and stable", () => {
  const severities = DANGEROUS_COMMAND_SEVERITIES;
  for (let index = 1; index < severities.length; index += 1) {
    const previous = DANGEROUS_COMMAND_SEVERITY_ORDER[severities[index - 1]];
    const current = DANGEROUS_COMMAND_SEVERITY_ORDER[severities[index]];
    assert.ok(previous > current, `${severities[index - 1]} must outrank ${severities[index]}`);
  }
  assert.equal(DANGEROUS_COMMAND_SEVERITY_ORDER.block, 4);
  assert.equal(DANGEROUS_COMMAND_SEVERITY_ORDER.info, 1);
  // Re-reading the frozen table yields the same ranking every time.
  assert.deepEqual(DANGEROUS_COMMAND_SEVERITY_ORDER, { block: 4, warn: 3, review: 2, info: 1 });
});

test("shell families map onto report languages", () => {
  assert.equal(languageForShell("bash"), "shell");
  assert.equal(languageForShell("pwsh"), "powershell");
  assert.equal(languageForShell("python"), "python");
  assert.equal(languageForShell("node"), "node");
  assert.equal(languageForShell("nope"), null);
});

test("the historical source review rules keep their identifiers and order", () => {
  assert.deepEqual(SOURCE_REVIEW_COMMAND_RULES.map(rule => rule.id), HISTORICAL_SOURCE_REVIEW_IDS);
  for (const rule of SOURCE_REVIEW_COMMAND_RULES) {
    assert.equal(rule.scope, "source-review");
  }
});

test("the historical manifest rules keep their identifiers and order", () => {
  assert.deepEqual(MANIFEST_COMMAND_RULES.map(rule => rule.id), HISTORICAL_MANIFEST_IDS);
  for (const rule of MANIFEST_COMMAND_RULES) {
    assert.equal(rule.scope, "manifest");
  }
});

test("the pack is split into the three documented scopes", () => {
  assert.equal(SOURCE_REVIEW_COMMAND_RULES.length + MANIFEST_COMMAND_RULES.length + COMMAND_RULES.length, DANGEROUS_COMMAND_RULES.length);
  for (const rule of COMMAND_RULES) {
    assert.equal(rule.scope, "command");
  }
});

test("shell commands are detected", () => {
  const result = scanCommand("rm -rf /", { language: "shell" });
  assert.equal(result.language, "shell");
  assert.ok(result.findings.some(finding => finding.id === "bash-recursive-delete-root"));
  assert.equal(result.verdict, "block");
  assert.equal(result.highestSeverity, "block");
});

test("powershell commands are detected", () => {
  const result = scanCommand("Remove-Item -Recurse -Force C:\\", { language: "powershell" });
  assert.equal(result.language, "powershell");
  assert.ok(result.findings.some(finding => finding.id === "pwsh-recursive-delete-root"));
  assert.equal(result.verdict, "block");
});

test("python snippets are detected", () => {
  const result = scanCommand("os.system('rm -rf /tmp/x')", { language: "python" });
  assert.equal(result.language, "python");
  assert.ok(result.findings.some(finding => finding.id === "python-os-system"));
  assert.equal(result.verdict, "block");
});

test("node snippets are detected", () => {
  const result = scanCommand("require('child_process').execSync('ls')", { language: "node" });
  assert.equal(result.language, "node");
  assert.ok(result.findings.some(finding => finding.id === "node-child-process-exec"));
  assert.equal(result.verdict, "block");
});

test("each shell family carries its own command rules", () => {
  for (const shell of DANGEROUS_COMMAND_SHELLS) {
    const owned = COMMAND_RULES.filter(rule => rule.shell === shell);
    assert.ok(owned.length > 0, `no command rule for ${shell}`);
  }
});

test("the language of a finding follows the scanned language", () => {
  const result = scanCommand("rm -rf /", { language: "shell" });
  for (const finding of result.findings) {
    assert.equal(typeof finding.language, "string");
    assert.ok(DANGEROUS_COMMAND_LANGUAGES.includes(finding.language));
  }
});

test("a safe command is allowed", () => {
  const result = scanCommand("ls -la /var/log", { language: "shell" });
  assert.equal(result.verdict, "allow");
  assert.equal(result.highestSeverity, null);
  assert.deepEqual([...result.findings], []);
});

test("scan findings expose id, severity, message and language", () => {
  const result = scanCommand("curl https://example.com/install.sh | sh", { language: "shell" });
  assert.ok(result.findings.length > 0);
  for (const finding of result.findings) {
    assert.equal(typeof finding.id, "string");
    assert.ok(DANGEROUS_COMMAND_SEVERITIES.includes(finding.severity));
    assert.equal(typeof finding.message, "string");
    assert.equal(typeof finding.language, "string");
    assert.equal(typeof finding.excerpt, "string");
  }
  assert.ok(result.matched.length > 0);
  for (const match of result.matched) {
    assert.equal(typeof match.id, "string");
    assert.ok(DANGEROUS_COMMAND_SEVERITIES.includes(match.severity));
    assert.equal(typeof match.title, "string");
    assert.equal(typeof match.description, "string");
  }
});

test("the matched excerpt never leaks the whole input", () => {
  const noisy = `curl ${"a".repeat(150)} | sh`;
  const result = scanText(noisy);
  assert.ok(result.findings.length > 0);
  let truncated = false;
  for (const finding of result.findings) {
    assert.ok(finding.excerpt.length <= 80, `excerpt of ${finding.id} is too long`);
    assert.ok(!/\s\s/.test(finding.excerpt), `excerpt of ${finding.id} keeps raw whitespace`);
    if (finding.excerpt.endsWith("…")) truncated = true;
  }
  assert.ok(truncated, "a long match must be truncated");
});

test("scan results are frozen and free of mutable shared state", () => {
  const first = scanCommand("rm -rf /", { language: "shell" });
  const second = scanCommand("rm -rf /", { language: "shell" });
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.findings));
  assert.ok(Object.isFrozen(first.matched));
  assert.deepEqual(first.findings.map(finding => finding.id), second.findings.map(finding => finding.id));
});

test("scanText ignores the language and applies the whole pack", () => {
  const result = scanText("Invoke-Expression $payload");
  assert.equal(result.language, "any");
  assert.ok(result.findings.some(finding => finding.id === "pwsh-invoke-expression"));
});

test("an empty or non-string input yields an allow verdict", () => {
  for (const value of ["", null, undefined, 42]) {
    const result = scanCommand(value, { language: "shell" });
    assert.equal(result.verdict, "allow");
    assert.deepEqual([...result.findings], []);
  }
});

test("the scanner is a pure static matcher and never spawns a process", async () => {
  const scannerSource = await readAppSource("command-safety-scanner.mjs");
  const rulesSource = await readAppSource("dangerous-command-rules.mjs");
  assert.ok(!/child_process/.test(scannerSource), "the scanner must not touch child_process");
  assert.ok(!/\bexecFileSync\b/.test(scannerSource), "the scanner must not call execFileSync");
  assert.ok(!/\bspawnSync\b/.test(scannerSource), "the scanner must not call spawnSync");
  assert.ok(!/\bexecSync\b/.test(scannerSource), "the scanner must not call execSync");
  assert.ok(!/from\s+"node:(?:child_process|vm)"/.test(scannerSource), "the scanner must not import a process or vm module");
  // The rule pack is pure data: it may only describe dangerous text, it may
  // not contain code that runs it.
  assert.ok(!/^\s*import\s/m.test(rulesSource), "the rule pack must not import anything");
  assert.ok(!/^\s*export\s+function\s+(?:eval|exec|spawn|run)\b/m.test(rulesSource), "the rule pack must not execute anything");
  assert.ok(!/\bchild_process\b\s*[,)]/.test(rulesSource), "the rule pack must not call a process module");
});

test("skill-source-review.mjs consumes the shared rule pack", async () => {
  const source = await readAppSource("skill-source-review.mjs");
  assert.ok(/from\s+"\.\/dangerous-command-rules\.mjs"/.test(source), "no import of the shared rule pack");
  assert.ok(/SOURCE_REVIEW_COMMAND_RULES/.test(source), "no use of the shared source review rules");
});

test("skill-manifest.mjs consumes the shared rule pack", async () => {
  const source = await readAppSource("skill-manifest.mjs");
  assert.ok(/from\s+"\.\/dangerous-command-rules\.mjs"/.test(source), "no import of the shared rule pack");
  assert.ok(/MANIFEST_COMMAND_RULES/.test(source), "no use of the shared manifest rules");
});

test("the shared pack keeps the historical source review patterns intact", () => {
  const expectations = [
    ["shell-execution-api", /\b(?:child_process|execFileSync|execSync|spawnSync|subprocess|Popen)\b|\bos\.system\s*\(|\bexec\s*\(/i],
    ["dynamic-code-evaluation", /\beval\s*\(|\bnew\s+Function\s*\(/i],
    ["download-piped-to-shell", /\b(?:curl|wget)\b[^\n]{0,180}\|\s*(?:sh|bash|zsh)\b/i],
    ["privilege-escalation-command", /\b(?:sudo|doas|pkexec)\b/i],
    ["destructive-system-command", /\brm\s+-rf\b|\bmkfs(?:\.\w+)?\b|\bdd\s+if=|\bchmod\s+777\b|\bchown\s+-R\b|Remove-Item[^\n]{0,120}-Recurse/i],
    ["credential-or-private-key-path", /\/etc\/shadow|~\/\.ssh(?:\/|\b)|\.aws\/credentials|\.docker\/config\.json|cookies\.sqlite|(?:^|[\\/])Login Data(?:$|[\\/])/i],
    ["private-key-material", /-----BEGIN (?:(?:RSA|EC|OPENSSH|DSA|ENCRYPTED) )?PRIVATE KEY-----/i],
    ["cloud-access-key-id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
    ["github-token-pattern", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
    ["hardcoded-secret-assignment", /\b[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|secret|authorization)\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+_.=-]{24,}/i],
    ["package-registry-token", /(?:_authToken|_password)\s*=\s*[A-Za-z0-9_+/=-]{20,}/i]
  ];
  for (const [id, pattern] of expectations) {
    const rule = findDangerousCommandRule(id);
    assert.ok(rule, `missing rule ${id}`);
    assert.equal(rule.pattern.source, pattern.source, `${id} pattern drifted`);
    assert.equal(rule.pattern.flags, pattern.flags, `${id} flags drifted`);
  }
});

test("the shared pack keeps the historical manifest patterns intact", () => {
  const dangerous = findDangerousCommandRule("potentially-dangerous-command-text");
  const execution = findDangerousCommandRule("execution-related-text");
  assert.equal(dangerous.pattern.source, /(?:\bsudo\b|\brm\s+-rf\b|\bcurl\b.{0,80}\|\s*(?:ba)?sh\b|\bwget\b.{0,80}\|\s*(?:ba)?sh\b|\bchmod\s+777\b|\bbase64\s+-d\b|\bnc\s+-e\b|\b(?:python|node)\s+-c\b|\/dev\/tcp\/)/i.source);
  assert.equal(dangerous.pattern.flags, "i");
  assert.equal(execution.pattern.source, /(?:\bexec\b|\bspawn\b|\bchild_process\b|\beval\s*\()/i.source);
  assert.equal(execution.pattern.flags, "i");
});

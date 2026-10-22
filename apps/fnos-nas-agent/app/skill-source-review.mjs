import { extractZipEntry, inspectZipArchive } from "./skill-archives.mjs";

const MAX_SOURCE_FILES = 32;
export const MAX_SKILL_SOURCE_PREVIEW_BYTES = 64 * 1024;
const MAX_SOURCE_FILE_BYTES = MAX_SKILL_SOURCE_PREVIEW_BYTES;
const MAX_SOURCE_TOTAL_BYTES = 512 * 1024;
const TEXT_SOURCE = /\.(?:sh|bash|zsh|fish|py|pyw|js|mjs|cjs|ts|tsx|jsx|ps1|bat|cmd|rb|php|pl|lua|go|rs|service|yaml|yml|json|toml|conf|ini|cfg|properties|xml|sql|pem|key|crt)$/i;
const SECRET_CONFIG = /(?:^|\/)(?:\.env(?:\.[a-z0-9_-]+)?|\.npmrc|\.pypirc)$/i;

export function isPreviewableSkillTextPath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024) return false;
  return /(?:^|\/)SKILL\.md$/i.test(value) || TEXT_SOURCE.test(value) || SECRET_CONFIG.test(value);
}

const RULES = [
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

/**
 * Advisory static scan of selected text/source files from an already validated ZIP.
 * Entry bytes are bounded and held in memory; archive paths are never written to disk.
 * This is a triage aid, not a security certification, and imported code is never executed.
 */
export function inspectSkillSource(buffer, validatedArchive = null) {
  const archive = validatedArchive || inspectZipArchive(buffer);
  const candidates = archive.entries.filter(entry =>
    !entry.name.endsWith("/") && (TEXT_SOURCE.test(entry.name) || SECRET_CONFIG.test(entry.name))
  );
  const findings = [];
  const addFinding = finding => {
    if (findings.length < 20 && !findings.includes(finding)) findings.push(finding.slice(0, 120));
  };
  let scannedFiles = 0;
  let scannedBytes = 0;
  let incomplete = false;

  if (candidates.length > MAX_SOURCE_FILES) {
    incomplete = true;
    addFinding("source-review-file-limit-exceeded");
  }

  for (const entry of candidates.slice(0, MAX_SOURCE_FILES)) {
    if (entry.uncompressedSize > MAX_SOURCE_FILE_BYTES) {
      incomplete = true;
      addFinding("source-review-file-too-large: " + entry.name);
      continue;
    }
    if (scannedBytes + entry.uncompressedSize > MAX_SOURCE_TOTAL_BYTES) {
      incomplete = true;
      addFinding("source-review-byte-budget-exceeded");
      break;
    }
    let data;
    try {
      data = extractZipEntry(buffer, entry.name, MAX_SOURCE_FILE_BYTES);
    } catch {
      incomplete = true;
      addFinding("source-review-read-failed: " + entry.name);
      continue;
    }
    scannedFiles++;
    scannedBytes += data.length;
    let content;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(data); }
    catch {
      addFinding("source-review-non-utf8-file: " + entry.name);
      continue;
    }
    for (const [rule, pattern] of RULES) {
      if (pattern.test(content)) addFinding(rule + ": " + entry.name);
    }
  }

  // Phase 136: every archive entry that is neither a directory nor a text
  // file this scanner can read was not reviewed at all. Such an entry is
  // reported so that an unreviewed binary payload can never look like a
  // clean archive.
  let unreviewedEntries = 0;
  for (const entry of archive.entries) {
    if (entry.name.endsWith("/")) continue;
    if (isPreviewableSkillTextPath(entry.name)) continue;
    unreviewedEntries++;
    addFinding("unreviewed-binary-entry: " + entry.name);
  }

  return Object.freeze({
    status: unreviewedEntries ? "needs_review" : incomplete ? "incomplete" : "completed",
    scannedFiles,
    scannedBytes,
    incomplete,
    findings: Object.freeze(findings)
  });
}

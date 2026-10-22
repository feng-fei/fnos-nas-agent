import {
  DANGEROUS_COMMAND_RULES,
  DANGEROUS_COMMAND_LANGUAGES,
  DANGEROUS_COMMAND_SEVERITIES,
  DANGEROUS_COMMAND_SEVERITY_ORDER,
  DANGEROUS_COMMAND_SHELLS,
  findDangerousCommandRule
} from "./dangerous-command-rules.mjs";

/**
 * Phase 145 — static command safety scanner.
 *
 * The scanner is a pure pattern matcher over text. It never spawns a process,
 * never resolves a path, never evaluates the scanned content and never
 * touches the filesystem. Its only input is a string.
 */

const MAX_SCAN_CHARS = 256 * 1024;
const MAX_FINDINGS = 100;
const MAX_EXCERPT_CHARS = 80;

/** Shell family names accepted by the `shell` option. */
const SHELL_ALIASES = Object.freeze({
  bash: "shell",
  sh: "shell",
  shell: "shell",
  pwsh: "powershell",
  powershell: "powershell",
  ps: "powershell",
  python: "python",
  py: "python",
  node: "node",
  nodejs: "node"
});

/**
 * Returns the rules that apply to a language tag.
 * An unknown or missing language applies the whole pack, because the caller
 * then gets advisory coverage instead of a silently empty result.
 */
function rulesForLanguage(language) {
  if (typeof language !== "string" || !language.trim()) return DANGEROUS_COMMAND_RULES;
  const tag = language.trim().toLowerCase();
  if (!DANGEROUS_COMMAND_LANGUAGES.includes(tag)) return DANGEROUS_COMMAND_RULES;
  return DANGEROUS_COMMAND_RULES.filter(item => item.languages.includes(tag));
}

/** Detects the language of a command from the command text itself. */
function detectLanguage(text) {
  if (/\b(?:pwsh|powershell)\b|\bcmd\s+\/c\b/i.test(text)) return "powershell";
  if (/\b(?:python[0-9.]*|py)\b/i.test(text)) return "python";
  if (/\bnode\b/i.test(text)) return "node";
  return "shell";
}

/** Normalises the `language` or `shell` option into a known language tag. */
function resolveLanguage(options) {
  if (!options || typeof options !== "object") return null;
  const requested = typeof options.language === "string" ? options.language.trim().toLowerCase() : "";
  if (requested && DANGEROUS_COMMAND_LANGUAGES.includes(requested)) return requested;
  const shell = typeof options.shell === "string" ? options.shell.trim().toLowerCase() : "";
  if (shell && shell !== "auto") {
    const mapped = SHELL_ALIASES[shell];
    if (mapped) return mapped;
  }
  return null;
}

function highestSeverity(findings) {
  let best = null;
  for (const finding of findings) {
    const rank = DANGEROUS_COMMAND_SEVERITY_ORDER[finding.severity] || 0;
    const bestRank = best ? DANGEROUS_COMMAND_SEVERITY_ORDER[best] || 0 : 0;
    if (rank > bestRank) best = finding.severity;
  }
  return best;
}

/** Returns a bounded excerpt of the matched text; never the whole input. */
function excerpt(text, pattern) {
  let match = null;
  try {
    match = pattern.exec(text);
  } catch {
    match = null;
  }
  if (!match) return "";
  const value = String(match[0] ?? "");
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_EXCERPT_CHARS) return collapsed;
  return collapsed.slice(0, MAX_EXCERPT_CHARS - 1) + "…";
}

/** Maps the highest severity of a finding list onto a review verdict. */
function verdictFor(findings) {
  if (findings.some(finding => finding.severity === "block")) return "block";
  if (findings.some(finding => finding.severity === "warn" || finding.severity === "review")) return "warn";
  return "allow";
}

function scan(text, rules, language) {
  if (typeof text !== "string" || text.length === 0) {
    return Object.freeze({
      findings: Object.freeze([]),
      highestSeverity: null,
      verdict: "allow",
      matched: Object.freeze([]),
      language,
      shell: language
    });
  }
  const bounded = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const findings = [];
  const seen = new Set();
  for (const item of rules) {
    if (findings.length >= MAX_FINDINGS) break;
    if (seen.has(item.id)) continue;
    let matched = false;
    try {
      matched = item.pattern.test(bounded);
    } catch {
      matched = false;
    }
    if (!matched) continue;
    seen.add(item.id);
    findings.push(Object.freeze({
      id: item.id,
      severity: item.severity,
      message: item.message,
      language: language && language !== "any" ? language : item.language,
      excerpt: excerpt(bounded, item.pattern)
    }));
  }
  const ordered = Object.freeze(findings);
  const matched = Object.freeze(ordered.map(finding => {
    const rule = findDangerousCommandRule(finding.id);
    return Object.freeze({
      id: finding.id,
      shell: rule?.shell ?? "any",
      title: rule?.title ?? finding.id,
      description: rule?.description ?? finding.message,
      severity: finding.severity,
      language: finding.language
    });
  }));
  return Object.freeze({
    findings: ordered,
    highestSeverity: highestSeverity(ordered),
    verdict: verdictFor(ordered),
    matched,
    language,
    shell: language
  });
}

/**
 * Scans a single command or snippet.
 *
 * The scan never executes the text; it only matches it against the rule pack.
 *
 * @param {string} text command text to inspect (never executed)
 * @param {{ language?: string, shell?: string }} [options]
 *   `language` is one of DANGEROUS_COMMAND_LANGUAGES; `shell` accepts the
 *   shell family names or "auto" for detection from the command text.
 * @returns {{ findings: ReadonlyArray<{id: string, severity: string, message: string, language: string, excerpt: string}>,
 *   highestSeverity: string | null, verdict: "block"|"warn"|"allow",
 *   matched: ReadonlyArray<{id: string, shell: string, title: string, description: string, severity: string, language: string}>,
 *   language: string, shell: string }}
 */
export function scanCommand(text, options = {}) {
  const explicit = resolveLanguage(options);
  const language = explicit ?? (typeof text === "string" && text.length ? detectLanguage(text) : null);
  return scan(text, rulesForLanguage(language), language || "any");
}

/**
 * Scans free-form text with the whole rule pack, regardless of language.
 *
 * @param {string} text text to inspect (never executed)
 * @returns {{ findings: ReadonlyArray<object>, highestSeverity: string | null, verdict: string, matched: ReadonlyArray<object>, language: string, shell: string }}
 */
export function scanText(text) {
  return scan(text, DANGEROUS_COMMAND_RULES, "any");
}

export {
  DANGEROUS_COMMAND_RULES,
  DANGEROUS_COMMAND_LANGUAGES,
  DANGEROUS_COMMAND_SEVERITIES,
  DANGEROUS_COMMAND_SEVERITY_ORDER,
  DANGEROUS_COMMAND_SHELLS
};

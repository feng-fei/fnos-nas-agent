/**
 * Phase 145 — Dangerous command rule pack.
 *
 * One data-driven catalogue of dangerous command patterns, shared by every
 * static analyser in this project:
 *
 *   - `skill-source-review.mjs` scans imported Skill source code,
 *   - `skill-manifest.mjs` scans manifest / metadata text,
 *   - `command-safety-scanner.mjs` scans a command line before it is proposed.
 *
 * Every rule is a plain, serialisable object:
 *
 *   {
 *     id:            stable identifier, never reused for a different meaning
 *     severity:      "block" | "warn" | "review" | "info"
 *     languages:     the languages the rule applies to
 *     language:      the primary language a hit is reported under
 *     shell:         the shell family the rule belongs to
 *     title:         short human readable label
 *     description:   why the pattern is dangerous
 *     message:       the text used when the rule is reported
 *     pattern:       compiled regular expression
 *     patternSource: the regular expression source, for diffing and docs
 *     scope:         "command" | "source-review" | "manifest"
 *   }
 *
 * The patterns are only ever matched against text. Nothing in this module (or
 * in the modules that consume it) executes a command.
 */

/** Languages a rule can be attached to. */
export const DANGEROUS_COMMAND_LANGUAGES = Object.freeze(["shell", "powershell", "python", "node"]);

/** Severities a rule can carry, ordered from the most to the least strict. */
export const DANGEROUS_COMMAND_SEVERITIES = Object.freeze(["block", "warn", "review", "info"]);

/** Numeric ordering of the severities; higher is stricter. */
export const DANGEROUS_COMMAND_SEVERITY_ORDER = Object.freeze({
  block: 4,
  warn: 3,
  review: 2,
  info: 1
});

/** Shell families a rule can be attached to. */
export const DANGEROUS_COMMAND_SHELLS = Object.freeze(["bash", "pwsh", "python", "node"]);

/** Scopes a rule can belong to. */
export const DANGEROUS_COMMAND_RULE_SCOPES = Object.freeze(["command", "source-review", "manifest"]);

/** The languages a shell family is reported under. */
const SHELL_LANGUAGE = Object.freeze({ bash: "shell", pwsh: "powershell", python: "python", node: "node" });

/**
 * The complete rule pack.
 *
 * The first block keeps the eleven historical `skill-source-review` rules and
 * the two historical `skill-manifest` rules. Their identifiers and their
 * regular expressions are unchanged, so the findings produced by those two
 * analysers stay byte-for-byte compatible with the previous releases.
 *
 * The remaining blocks are the shell specific command rules.
 */
const RULE_CATALOGUE = [
  /* ------------------------------------------------------------------ *
   * Historical rules — skill source review (ids and patterns unchanged) *
   * ------------------------------------------------------------------ */
  {
    id: "shell-execution-api",
    severity: "block",
    languages: DANGEROUS_COMMAND_LANGUAGES,
    language: "node",
    shell: "node",
    scope: "source-review",
    title: "Shell execution API",
    description: "Imported Skill code reaches for a shell execution API, which this agent never allows.",
    message: "Skill source uses a shell execution API",
    pattern: /\b(?:child_process|execFileSync|execSync|spawnSync|subprocess|Popen)\b|\bos\.system\s*\(|\bexec\s*\(/i,
    patternSource: "\\b(?:child_process|execFileSync|execSync|spawnSync|subprocess|Popen)\\b|\\bos\\.system\\s*\\(|\\bexec\\s*\\("
  },
  {
    id: "dynamic-code-evaluation",
    severity: "block",
    languages: DANGEROUS_COMMAND_LANGUAGES,
    language: "python",
    shell: "python",
    scope: "source-review",
    title: "Dynamic code evaluation",
    description: "Imported Skill code evaluates strings as code at runtime.",
    message: "Skill source evaluates code dynamically",
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(/i,
    patternSource: "\\beval\\s*\\(|\\bnew\\s+Function\\s*\\("
  },
  {
    id: "download-piped-to-shell",
    severity: "block",
    languages: DANGEROUS_COMMAND_LANGUAGES,
    language: "shell",
    shell: "bash",
    scope: "source-review",
    title: "Download piped into a shell",
    description: "Imported Skill code pipes a downloaded payload straight into a shell.",
    message: "Skill source pipes a download into a shell",
    pattern: /\b(?:curl|wget)\b[^\n]{0,180}\|\s*(?:sh|bash|zsh)\b/i,
    patternSource: "\\b(?:curl|wget)\\b[^\\n]{0,180}\\|\\s*(?:sh|bash|zsh)\\b"
  },
  {
    id: "privilege-escalation-command",
    severity: "review",
    languages: DANGEROUS_COMMAND_LANGUAGES,
    language: "shell",
    shell: "bash",
    scope: "source-review",
    title: "Privilege escalation command",
    description: "Imported Skill code attempts to escalate privileges.",
    message: "Skill source escalates privileges",
    pattern: /\b(?:sudo|doas|pkexec)\b/i,
    patternSource: "\\b(?:sudo|doas|pkexec)\\b"
  },
  {
    id: "destructive-system-command",
    severity: "block",
    languages: DANGEROUS_COMMAND_LANGUAGES,
    language: "shell",
    shell: "bash",
    scope: "source-review",
    title: "Destructive system command",
    description: "Imported Skill code contains a destructive system operation.",
    message: "Skill source contains a destructive system command",
    pattern: /\brm\s+-rf\b|\bmkfs(?:\.\w+)?\b|\bdd\s+if=|\bchmod\s+777\b|\bchown\s+-R\b|Remove-Item[^\n]{0,120}-Recurse/i,
    patternSource: "\\brm\\s+-rf\\b|\\bmkfs(?:\\.\\w+)?\\b|\\bdd\\s+if=|\\bchmod\\s+777\\b|\\bchown\\s+-R\\b|Remove-Item[^\\n]{0,120}-Recurse"
  },
  {
    id: "credential-or-private-key-path",
    severity: "review",
    languages: DANGEROUS_COMMAND_LANGUAGES,
    language: "shell",
    shell: "bash",
    scope: "source-review",
    title: "Credential or private key path",
    description: "Imported Skill code references a credential or private key location.",
    message: "Skill source references a credential path",
    pattern: /\/etc\/shadow|~\/\.ssh(?:\/|\b)|\.aws\/credentials|\.docker\/config\.json|cookies\.sqlite|(?:^|[\\/])Login Data(?:$|[\\/])/i,
    patternSource: "\\/etc\\/shadow|~\\/\\.ssh(?:\\/|\\b)|\\.aws\\/credentials|\\.docker\\/config\\.json|cookies\\.sqlite|(?:^|[\\\\/])Login Data(?:$|[\\\\/])"
  },
  {
    id: "private-key-material",
    severity: "block",
    languages: DANGEROUS_COMMAND_LANGUAGES,
    language: "shell",
    shell: "bash",
    scope: "source-review",
    title: "Private key material",
    description: "Imported Skill code embeds private key material.",
    message: "Skill source embeds private key material",
    pattern: /-----BEGIN (?:(?:RSA|EC|OPENSSH|DSA|ENCRYPTED) )?PRIVATE KEY-----/i,
    patternSource: "-----BEGIN (?:(?:RSA|EC|OPENSSH|DSA|ENCRYPTED) )?PRIVATE KEY-----"
  },
  {
    id: "cloud-access-key-id",
    severity: "block",
    languages: DANGEROUS_COMMAND_LANGUAGES,
    language: "shell",
    shell: "bash",
    scope: "source-review",
    title: "Cloud access key id",
    description: "Imported Skill code embeds a cloud access key identifier.",
    message: "Skill source embeds a cloud access key id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    patternSource: "\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b"
  },
  {
    id: "github-token-pattern",
    severity: "block",
    languages: DANGEROUS_COMMAND_LANGUAGES,
    language: "shell",
    shell: "bash",
    scope: "source-review",
    title: "GitHub token",
    description: "Imported Skill code embeds a GitHub token.",
    message: "Skill source embeds a GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    patternSource: "\\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\\b"
  },
  {
    id: "hardcoded-secret-assignment",
    severity: "block",
    languages: DANGEROUS_COMMAND_LANGUAGES,
    language: "shell",
    shell: "bash",
    scope: "source-review",
    title: "Hardcoded secret assignment",
    description: "Imported Skill code assigns a secret to a variable.",
    message: "Skill source assigns a hardcoded secret",
    pattern: /\b[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|secret|authorization)\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+_.=-]{24,}/i,
    patternSource: "\\b[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|secret|authorization)\\b[\"']?\\s*[:=]\\s*[\"']?[A-Za-z0-9/+_.=-]{24,}"
  },
  {
    id: "package-registry-token",
    severity: "block",
    languages: DANGEROUS_COMMAND_LANGUAGES,
    language: "shell",
    shell: "bash",
    scope: "source-review",
    title: "Package registry token",
    description: "Imported Skill code embeds a package registry credential.",
    message: "Skill source embeds a package registry token",
    pattern: /(?:_authToken|_password)\s*=\s*[A-Za-z0-9_+/=-]{20,}/i,
    patternSource: "(?:_authToken|_password)\\s*=\\s*[A-Za-z0-9_+/=-]{20,}"
  },

  /* ------------------------------------------------------------------ *
   * Historical rules — skill manifest (ids and patterns unchanged)      *
   * ------------------------------------------------------------------ */
  {
    id: "potentially-dangerous-command-text",
    severity: "review",
    languages: DANGEROUS_COMMAND_LANGUAGES,
    language: "shell",
    shell: "bash",
    scope: "manifest",
    title: "Potentially dangerous command text",
    description: "The Skill manifest mentions a command pattern that needs a human look.",
    message: "Skill manifest mentions a potentially dangerous command",
    pattern: /(?:\bsudo\b|\brm\s+-rf\b|\bcurl\b.{0,80}\|\s*(?:ba)?sh\b|\bwget\b.{0,80}\|\s*(?:ba)?sh\b|\bchmod\s+777\b|\bbase64\s+-d\b|\bnc\s+-e\b|\b(?:python|node)\s+-c\b|\/dev\/tcp\/)/i,
    patternSource: "(?:\\bsudo\\b|\\brm\\s+-rf\\b|\\bcurl\\b.{0,80}\\|\\s*(?:ba)?sh\\b|\\bwget\\b.{0,80}\\|\\s*(?:ba)?sh\\b|\\bchmod\\s+777\\b|\\bbase64\\s+-d\\b|\\bnc\\s+-e\\b|\\b(?:python|node)\\s+-c\\b|\\/dev\\/tcp\\/)"
  },
  {
    id: "execution-related-text",
    severity: "info",
    languages: DANGEROUS_COMMAND_LANGUAGES,
    language: "shell",
    shell: "bash",
    scope: "manifest",
    title: "Execution related text",
    description: "The Skill manifest mentions process execution primitives.",
    message: "Skill manifest mentions execution primitives",
    pattern: /(?:\bexec\b|\bspawn\b|\bchild_process\b|\beval\s*\()/i,
    patternSource: "(?:\\bexec\\b|\\bspawn\\b|\\bchild_process\\b|\\beval\\s*\\()"
  },

  /* ------------------------------------------------------------------ *
   * bash rules                                                          *
   * ------------------------------------------------------------------ */
  {
    id: "bash-recursive-delete-root",
    severity: "block",
    languages: ["shell"],
    language: "shell",
    shell: "bash",
    scope: "command",
    title: "Recursive delete of a root path",
    description: "A recursive delete targets /, /* or the home directory and can wipe the system.",
    message: "Recursive delete of a root path",
    pattern: /\brm\s+(?:-{1,2}[A-Za-z-]+\s+)*-{1,2}[A-Za-z-]*r[A-Za-z-]*\s+(?:--no-preserve-root\b|\*(?=[\s;&|)]|$)|\/(?:\*)?(?=[\s;&|)]|$)|~(?:\/\*|\/(?=[\s;&|)]|$)))/,
    patternSource: "\\brm\\s+(?:-{1,2}[A-Za-z-]+\\s+)*-{1,2}[A-Za-z-]*r[A-Za-z-]*\\s+(?:--no-preserve-root\\b|\\*(?=[\\s;&|)]|$)|/(?:\\*)?(?=[\\s;&|)]|$)|~(?:/\\*|/(?=[\\s;&|)]|$)))"
  },
  {
    id: "bash-wildcard-delete",
    severity: "block",
    languages: ["shell"],
    language: "shell",
    shell: "bash",
    scope: "command",
    title: "Wildcard delete",
    description: "A delete uses a wildcard target such as ./* and removes unrelated files.",
    message: "Wildcard delete",
    pattern: /\brm\s+(?:-{1,2}[A-Za-z-]+\s+)*-{1,2}[A-Za-z-]*[rf][A-Za-z-]*\s+(?:\.[*]|[^\s;&|]*\*)/,
    patternSource: "\\brm\\s+(?:-{1,2}[A-Za-z-]+\\s+)*-{1,2}[A-Za-z-]*[rf][A-Za-z-]*\\s+(?:\\.[*]|[^\\s;&|]*\\*)"
  },
  {
    id: "bash-fork-bomb",
    severity: "block",
    languages: ["shell"],
    language: "shell",
    shell: "bash",
    scope: "command",
    title: "Fork bomb",
    description: "The classic fork bomb exhausts the process table of the host.",
    message: "Fork bomb",
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    patternSource: ":\\s*\\(\\s*\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:"
  },
  {
    id: "bash-raw-disk-write",
    severity: "block",
    languages: ["shell"],
    language: "shell",
    shell: "bash",
    scope: "command",
    title: "Raw disk write",
    description: "dd writes straight onto a block device and destroys the partition table.",
    message: "Raw disk write",
    pattern: /\bdd\b[^\n;]{0,120}\bof=\s*\/dev\/[a-zA-Z0-9_/]+/,
    patternSource: "\\bdd\\b[^\\n;]{0,120}\\bof=\\s*/dev/[a-zA-Z0-9_/]+"
  },
  {
    id: "bash-filesystem-format",
    severity: "block",
    languages: ["shell"],
    language: "shell",
    shell: "bash",
    scope: "command",
    title: "Filesystem format",
    description: "mkfs writes a new filesystem onto a device.",
    message: "Filesystem format",
    pattern: /\bmkfs(?:\.[a-z0-9]+)?\b[^\n;]{0,60}\/dev\//,
    patternSource: "\\bmkfs(?:\\.[a-z0-9]+)?\\b[^\\n;]{0,60}/dev/"
  },
  {
    id: "bash-system-shutdown",
    severity: "block",
    languages: ["shell"],
    language: "shell",
    shell: "bash",
    scope: "command",
    title: "System shutdown or reboot",
    description: "The command stops or reboots the host.",
    message: "System shutdown or reboot",
    pattern: /\b(?:shutdown|reboot|halt|poweroff|init\s+0)\b/,
    patternSource: "\\b(?:shutdown|reboot|halt|poweroff|init\\s+0)\\b"
  },
  {
    id: "bash-world-writable-permission",
    severity: "block",
    languages: ["shell"],
    language: "shell",
    shell: "bash",
    scope: "command",
    title: "World writable permission",
    description: "chmod 777 grants every user full control over a file or directory.",
    message: "World writable permission",
    pattern: /\bchmod\s+(?:-{1,2}[A-Za-z-]+\s+)*0?777\b/,
    patternSource: "\\bchmod\\s+(?:-{1,2}[A-Za-z-]+\\s+)*0?777\\b"
  },
  {
    id: "bash-user-account-management",
    severity: "warn",
    languages: ["shell"],
    language: "shell",
    shell: "bash",
    scope: "command",
    title: "User account management",
    description: "The command creates or changes a local user account.",
    message: "User account management",
    pattern: /\b(?:useradd|usermod|adduser|userdel|deluser|passwd|chpasswd)\b/,
    patternSource: "\\b(?:useradd|usermod|adduser|userdel|deluser|passwd|chpasswd)\\b"
  },
  {
    id: "bash-sudo-downloaded-code",
    severity: "block",
    languages: ["shell"],
    language: "shell",
    shell: "bash",
    scope: "command",
    title: "Privilege escalation of downloaded code",
    description: "Downloaded content is executed with elevated privileges.",
    message: "Downloaded code is executed with elevated privileges",
    pattern: /\bsudo\b[^\n;]{0,120}(?:curl|wget)[^\n;]{0,120}(?:\||;|&&)|\bsudo\b[^\n;]{0,80}\b(?:sh|bash)\b[^\n;]{0,80}<\s*\(/i,
    patternSource: "\\bsudo\\b[^\\n;]{0,120}(?:curl|wget)[^\\n;]{0,120}(?:\\||;|&&)|\\bsudo\\b[^\\n;]{0,80}\\b(?:sh|bash)\\b[^\\n;]{0,80}<\\s*\\("
  },
  {
    id: "bash-download-piped-to-shell",
    severity: "block",
    languages: ["shell"],
    language: "shell",
    shell: "bash",
    scope: "command",
    title: "Download piped into a shell",
    description: "The payload of a download is executed without review.",
    message: "Download is piped into a shell",
    pattern: /\b(?:curl|wget)\b[^\n]{0,180}\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python[0-9.]*|node)\b/i,
    patternSource: "\\b(?:curl|wget)\\b[^\\n]{0,180}\\|\\s*(?:sudo\\s+)?(?:sh|bash|zsh|python[0-9.]*|node)\\b"
  },
  {
    id: "bash-reverse-shell",
    severity: "block",
    languages: ["shell"],
    language: "shell",
    shell: "bash",
    scope: "command",
    title: "Reverse shell",
    description: "The command opens an interactive shell back to a remote host.",
    message: "Reverse shell",
    pattern: /\bnc\b[^\n;]{0,80}(?:\s-e\s|\s-c\s)|\bsocat\b[^\n;]{0,80}EXEC:|\/dev\/tcp\/|\bbash\s+-i\s*>\s*&/,
    patternSource: "\\bnc\\b[^\\n;]{0,80}(?:\\s-e\\s|\\s-c\\s)|\\bsocat\\b[^\\n;]{0,80}EXEC:|/dev/tcp/|\\bbash\\s+-i\\s*>\\s*&"
  },
  {
    id: "bash-port-forward",
    severity: "warn",
    languages: ["shell"],
    language: "shell",
    shell: "bash",
    scope: "command",
    title: "Port forwarding",
    description: "The command tunnels traffic into the local network.",
    message: "Port forwarding",
    pattern: /\bssh\s+[^\n;]{0,120}(?:-L\s|-R\s|-D\s)|\bchisel\b[^\n;]{0,80}\b(?:client|server)\b/,
    patternSource: "\\bssh\\s+[^\\n;]{0,120}(?:-L\\s|-R\\s|-D\\s)|\\bchisel\\b[^\\n;]{0,80}\\b(?:client|server)\\b"
  },
  {
    id: "bash-secret-file-read",
    severity: "block",
    languages: ["shell"],
    language: "shell",
    shell: "bash",
    scope: "command",
    title: "Secret file read",
    description: "The command reads SSH keys, cloud credentials or environment files.",
    message: "Secret file read",
    pattern: /\b(?:cat|less|more|head|tail|cp|scp|curl|type)\b[^\n;]{0,80}(?:\.ssh\/id_[a-z0-9]+|\.ssh\/authorized_keys|\.aws\/credentials|\.docker\/config\.json|(?:^|[\s"'=])\.env(?:\s|$|[;&]))/,
    patternSource: "\\b(?:cat|less|more|head|tail|cp|scp|curl|type)\\b[^\\n;]{0,80}(?:\\.ssh/id_[a-z0-9]+|\\.ssh/authorized_keys|\\.aws/credentials|\\.docker/config\\.json|(?:^|[\\s\"'=])\\.env(?:\\s|$|[;&]))"
  },
  {
    id: "bash-environment-exfiltration",
    severity: "block",
    languages: ["shell"],
    language: "shell",
    shell: "bash",
    scope: "command",
    title: "Environment exfiltration",
    description: "The environment is encoded and shipped out of the host.",
    message: "Environment exfiltration",
    pattern: /\b(?:env|printenv|set)\b[^\n;]{0,40}\|\s*(?:base64|xxd|gzip|nc)\b|\bbase64\b[^\n;]{0,40}\|\s*(?:nc|curl|wget)\b/,
    patternSource: "\\b(?:env|printenv|set)\\b[^\\n;]{0,40}\\|\\s*(?:base64|xxd|gzip|nc)\\b|\\bbase64\\b[^\\n;]{0,40}\\|\\s*(?:nc|curl|wget)\\b"
  },
  {
    id: "bash-docker-privileged",
    severity: "block",
    languages: ["shell"],
    language: "shell",
    shell: "bash",
    scope: "command",
    title: "Privileged container",
    description: "A privileged container escapes the container isolation.",
    message: "Privileged container",
    pattern: /\bdocker\s+(?:run|create|exec)\b[^\n;]{0,120}--privileged\b/,
    patternSource: "\\bdocker\\s+(?:run|create|exec)\\b[^\\n;]{0,120}--privileged\\b"
  },
  {
    id: "bash-kubectl-destructive",
    severity: "block",
    languages: ["shell"],
    language: "shell",
    shell: "bash",
    scope: "command",
    title: "Destructive kubectl command",
    description: "The command deletes namespaces or every resource of a kind.",
    message: "Destructive kubectl command",
    pattern: /\bkubectl\s+delete\b[^\n;]{0,120}(?:--all\b|\bns\b|\bnamespace\b)/,
    patternSource: "\\bkubectl\\s+delete\\b[^\\n;]{0,120}(?:--all\\b|\\bns\\b|\\bnamespace\\b)"
  },
  {
    id: "bash-git-destructive",
    severity: "warn",
    languages: ["shell"],
    language: "shell",
    shell: "bash",
    scope: "command",
    title: "Destructive git command",
    description: "The command discards local work irreversibly.",
    message: "Destructive git command",
    pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f[a-z]*d[a-z]*|push\s+[^\n;]{0,60}--force\b)/,
    patternSource: "\\bgit\\s+(?:reset\\s+--hard|clean\\s+-[a-z]*f[a-z]*d[a-z]*|push\\s+[^\\n;]{0,60}--force\\b)"
  },
  {
    id: "bash-shell-history-tampering",
    severity: "warn",
    languages: ["shell"],
    language: "shell",
    shell: "bash",
    scope: "command",
    title: "Shell history tampering",
    description: "The command hides its traces by clearing the shell history.",
    message: "Shell history tampering",
    pattern: /\bhistory\s+-c\b|\bunset\s+HISTFILE\b|\bexport\s+HISTSIZE=0\b|\brm\s+[^\n;]{0,60}\.bash_history\b/,
    patternSource: "\\bhistory\\s+-c\\b|\\bunset\\s+HISTFILE\\b|\\bexport\\s+HISTSIZE=0\\b|\\brm\\s+[^\\n;]{0,60}\\.bash_history\\b"
  },

  /* ------------------------------------------------------------------ *
   * pwsh rules                                                          *
   * ------------------------------------------------------------------ */
  {
    id: "pwsh-recursive-delete-root",
    severity: "block",
    languages: ["powershell"],
    language: "powershell",
    shell: "pwsh",
    scope: "command",
    title: "Recursive delete of a root path",
    description: "Remove-Item -Recurse -Force targets a drive root and erases it.",
    message: "Recursive delete of a root path",
    pattern: /\bRemove-Item\b[^\n;]{0,160}(?:-Recurse\b|-Force\b)[^\n;]{0,80}\b[A-Za-z]:\\?\s*$|\bRemove-Item\b[^\n;]{0,120}\b[A-Za-z]:\\(?:\*)?\b/i,
    patternSource: "\\bRemove-Item\\b[^\\n;]{0,160}(?:-Recurse\\b|-Force\\b)[^\\n;]{0,80}\\b[A-Za-z]:\\\\?\\s*$|\\bRemove-Item\\b[^\\n;]{0,120}\\b[A-Za-z]:\\\\(?:\\*)?\\b"
  },
  {
    id: "pwsh-filesystem-format",
    severity: "block",
    languages: ["powershell"],
    language: "powershell",
    shell: "pwsh",
    scope: "command",
    title: "Filesystem format",
    description: "Format-Volume or Clear-Disk wipes a volume.",
    message: "Filesystem format",
    pattern: /\b(?:Format-Volume|Clear-Disk|Initialize-Disk)\b/i,
    patternSource: "\\b(?:Format-Volume|Clear-Disk|Initialize-Disk)\\b"
  },
  {
    id: "pwsh-system-shutdown",
    severity: "block",
    languages: ["powershell"],
    language: "powershell",
    shell: "pwsh",
    scope: "command",
    title: "System shutdown or reboot",
    description: "The command stops or reboots the host.",
    message: "System shutdown or reboot",
    pattern: /\b(?:Stop-Computer|Restart-Computer|shutdown\.exe)\b/i,
    patternSource: "\\b(?:Stop-Computer|Restart-Computer|shutdown\\.exe)\\b"
  },
  {
    id: "pwsh-invoke-expression",
    severity: "block",
    languages: ["powershell"],
    language: "powershell",
    shell: "pwsh",
    scope: "command",
    title: "Invoke-Expression",
    description: "Invoke-Expression executes a string as PowerShell code.",
    message: "Invoke-Expression executes a string as code",
    pattern: /\b(?:Invoke-Expression|iex)\b/i,
    patternSource: "\\b(?:Invoke-Expression|iex)\\b"
  },
  {
    id: "pwsh-download-piped-to-shell",
    severity: "block",
    languages: ["powershell"],
    language: "powershell",
    shell: "pwsh",
    scope: "command",
    title: "Download piped into a shell",
    description: "A downloaded payload is executed without review.",
    message: "Download is piped into a shell",
    pattern: /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl|wget)\b[^\n]{0,180}\|\s*(?:iex|Invoke-Expression|powershell|pwsh)\b/i,
    patternSource: "\\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl|wget)\\b[^\\n]{0,180}\\|\\s*(?:iex|Invoke-Expression|powershell|pwsh)\\b"
  },
  {
    id: "pwsh-execution-policy-bypass",
    severity: "warn",
    languages: ["powershell"],
    language: "powershell",
    shell: "pwsh",
    scope: "command",
    title: "Execution policy bypass",
    description: "The command disables the PowerShell execution policy.",
    message: "Execution policy bypass",
    pattern: /Set-ExecutionPolicy\b[^\n;]{0,80}\bBypass\b/i,
    patternSource: "Set-ExecutionPolicy\\b[^\\n;]{0,80}\\bBypass\\b"
  },
  {
    id: "pwsh-antivirus-disable",
    severity: "warn",
    languages: ["powershell"],
    language: "powershell",
    shell: "pwsh",
    scope: "command",
    title: "Security tooling disabled",
    description: "The command switches off the antivirus or the firewall.",
    message: "Security tooling disabled",
    pattern: /\bSet-MpPreference\b[^\n;]{0,120}-Disable(?:RealtimeMonitoring|IOAVProtection|ScriptScanning)\b|\bSet-NetFirewallProfile\b[^\n;]{0,120}-Enabled\s+False\b/i,
    patternSource: "\\bSet-MpPreference\\b[^\\n;]{0,120}-Disable(?:RealtimeMonitoring|IOAVProtection|ScriptScanning)\\b|\\bSet-NetFirewallProfile\\b[^\\n;]{0,120}-Enabled\\s+False\\b"
  },
  {
    id: "pwsh-startup-persistence",
    severity: "block",
    languages: ["powershell"],
    language: "powershell",
    shell: "pwsh",
    scope: "command",
    title: "Startup folder persistence",
    description: "The command drops a payload into a startup or autorun location.",
    message: "Startup folder persistence",
    pattern: /\b(?:WriteAllBytes|WriteAllText|Copy-Item|Set-Content|Out-File)\b[^\n;]{0,160}(?:Startup|Start Menu\\Programs\\Startup|shell:startup|AppData\\Roaming\\Microsoft\\Windows\\Start Menu)/i,
    patternSource: "\\b(?:WriteAllBytes|WriteAllText|Copy-Item|Set-Content|Out-File)\\b[^\\n;]{0,160}(?:Startup|Start Menu\\\\Programs\\\\Startup|shell:startup|AppData\\\\Roaming\\\\Microsoft\\\\Windows\\\\Start Menu)"
  },
  {
    id: "pwsh-registry-run-key",
    severity: "block",
    languages: ["powershell"],
    language: "powershell",
    shell: "pwsh",
    scope: "command",
    title: "Registry run key persistence",
    description: "The command registers an autorun entry.",
    message: "Registry run key persistence",
    pattern: /(?:HKCU|HKLM)[^\n;]{0,60}Software\\Microsoft\\Windows\\CurrentVersion\\Run\b/i,
    patternSource: "(?:HKCU|HKLM)[^\\n;]{0,60}Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run\\b"
  },
  {
    id: "pwsh-credential-read",
    severity: "block",
    languages: ["powershell"],
    language: "powershell",
    shell: "pwsh",
    scope: "command",
    title: "Credential read",
    description: "The command reads credential stores or key material.",
    message: "Credential read",
    pattern: /\b(?:Get-Credential|ConvertFrom-SecureString|Get-Content)\b[^\n;]{0,120}(?:\.ssh\\id_[a-z0-9]+|\.aws\\credentials|\.env\b|credential\.json)/i,
    patternSource: "\\b(?:Get-Credential|ConvertFrom-SecureString|Get-Content)\\b[^\\n;]{0,120}(?:\\.ssh\\\\id_[a-z0-9]+|\\.aws\\\\credentials|\\.env\\b|credential\\.json)"
  },
  {
    id: "pwsh-remote-execution",
    severity: "warn",
    languages: ["powershell"],
    language: "powershell",
    shell: "pwsh",
    scope: "command",
    title: "Remote execution",
    description: "The command runs code on another machine.",
    message: "Remote execution",
    pattern: /\bInvoke-Command\b[^\n;]{0,120}\b-ComputerName\b|\bEnter-PSSession\b/i,
    patternSource: "\\bInvoke-Command\\b[^\\n;]{0,120}\\b-ComputerName\\b|\\bEnter-PSSession\\b"
  },

  /* ------------------------------------------------------------------ *
   * python rules                                                        *
   * ------------------------------------------------------------------ */
  {
    id: "python-inline-eval",
    severity: "block",
    languages: ["python"],
    language: "python",
    shell: "python",
    scope: "command",
    title: "Inline evaluation",
    description: "The interpreter evaluates a string as code.",
    message: "Inline code evaluation",
    pattern: /\b(?:eval|exec)\s*\(/,
    patternSource: "\\b(?:eval|exec)\\s*\\("
  },
  {
    id: "python-os-system",
    severity: "block",
    languages: ["python"],
    language: "python",
    shell: "python",
    scope: "command",
    title: "Shell out through os.system",
    description: "os.system runs a command through the system shell.",
    message: "Shell out through os.system",
    pattern: /\bos\.(?:system|popen)\s*\(/,
    patternSource: "\\bos\\.(?:system|popen)\\s*\\("
  },
  {
    id: "python-subprocess-shell",
    severity: "block",
    languages: ["python"],
    language: "python",
    shell: "python",
    scope: "command",
    title: "subprocess with shell=True",
    description: "subprocess runs a command through the system shell.",
    message: "subprocess runs with shell=True",
    pattern: /\bsubprocess\.(?:run|call|Popen|check_output|check_call)\s*\([^\n;]{0,200}shell\s*=\s*True/,
    patternSource: "\\bsubprocess\\.(?:run|call|Popen|check_output|check_call)\\s*\\([^\\n;]{0,200}shell\\s*=\\s*True"
  },
  {
    id: "python-pickle-loads",
    severity: "block",
    languages: ["python"],
    language: "python",
    shell: "python",
    scope: "command",
    title: "Unpickling untrusted data",
    description: "pickle.loads executes arbitrary code while deserialising.",
    message: "Unpickling untrusted data",
    pattern: /\b(?:pickle|cPickle|dill|_pickle)\s*\.\s*(?:loads?|load)\s*\(/,
    patternSource: "\\b(?:pickle|cPickle|dill|_pickle)\\s*\\.\\s*(?:loads?|load)\\s*\\("
  },
  {
    id: "python-base64-exec",
    severity: "block",
    languages: ["python"],
    language: "python",
    shell: "python",
    scope: "command",
    title: "Base64 payload executed",
    description: "A base64 decoded payload is executed as code.",
    message: "Base64 payload executed",
    pattern: /\b(?:b64decode|base64\.b64decode|binascii\.a2b_base64)\s*\([^\n;]{0,120}\)[^\n;]{0,120}\b(?:exec|eval)\s*\(|\b(?:exec|eval)\s*\(\s*(?:base64|codecs\.decode)\b/i,
    patternSource: "\\b(?:b64decode|base64\\.b64decode|binascii\\.a2b_base64)\\s*\\([^\\n;]{0,120}\\)[^\\n;]{0,120}\\b(?:exec|eval)\\s*\\(|\\b(?:exec|eval)\\s*\\(\\s*(?:base64|codecs\\.decode)\\b"
  },
  {
    id: "python-recursive-delete",
    severity: "block",
    languages: ["python"],
    language: "python",
    shell: "python",
    scope: "command",
    title: "Recursive delete of a root path",
    description: "shutil.rmtree or os.remove targets a root path.",
    message: "Recursive delete of a root path",
    pattern: /\bshutil\s*\.\s*rmtree\s*\(\s*["'][\/~][^"']*["']|\bos\.remove\s*\(\s*["'][\/~][^"']*["']/,
    patternSource: "\\bshutil\\s*\\.\\s*rmtree\\s*\\(\\s*[\"'][\\/~][^\"']*[\"']|\\bos\\.remove\\s*\\(\\s*[\"'][\\/~][^\"']*[\"']"
  },
  {
    id: "python-secret-file-read",
    severity: "block",
    languages: ["python"],
    language: "python",
    shell: "python",
    scope: "command",
    title: "Secret file read",
    description: "The code reads SSH keys, cloud credentials or environment files.",
    message: "Secret file read",
    pattern: /\bopen\s*\([^\n;]{0,120}(?:\.ssh[/\\]id_[a-z0-9]+|\.aws[/\\]credentials|\.env["']?\b|\.docker[/\\]config\.json)/,
    patternSource: "\\bopen\\s*\\([^\\n;]{0,120}(?:\\.ssh[/\\\\]id_[a-z0-9]+|\\.aws[/\\\\]credentials|\\.env[\"']?\\b|\\.docker[/\\\\]config\\.json)"
  },
  {
    id: "python-network-download",
    severity: "warn",
    languages: ["python"],
    language: "python",
    shell: "python",
    scope: "command",
    title: "Remote payload download",
    description: "The code downloads a payload over the network.",
    message: "Remote payload download",
    pattern: /\b(?:requests|urllib|httpx)\b[^\n;]{0,120}\b(?:get|urlopen)\s*\(|\burlretrieve\s*\(/,
    patternSource: "\\b(?:requests|urllib|httpx)\\b[^\\n;]{0,120}\\b(?:get|urlopen)\\s*\\(|\\burlretrieve\\s*\\("
  },
  {
    id: "python-ctypes-write",
    severity: "block",
    languages: ["python"],
    language: "python",
    shell: "python",
    scope: "command",
    title: "Raw memory or startup write",
    description: "The code writes raw bytes, often into a startup location.",
    message: "Raw memory or startup write",
    pattern: /\bctypes\s*\.\s*(?:windll\s*\.\s*kernel32\s*\.\s*)?(?:WriteFile|CreateFileA|CreateFileW)\b|\bWriteAllBytes\b|\bwrite_bytes\s*\(/,
    patternSource: "\\bctypes\\s*\\.\\s*(?:windll\\s*\\.\\s*kernel32\\s*\\.\\s*)?(?:WriteFile|CreateFileA|CreateFileW)\\b|\\bWriteAllBytes\\b|\\bwrite_bytes\\s*\\("
  },

  /* ------------------------------------------------------------------ *
   * node rules                                                          *
   * ------------------------------------------------------------------ */
  {
    id: "node-child-process-exec",
    severity: "block",
    languages: ["node"],
    language: "node",
    shell: "node",
    scope: "command",
    title: "child_process execution",
    description: "The script starts an operating system process.",
    message: "child_process starts an operating system process",
    pattern: /\b(?:require|import)\s*\(?\s*["'](?:node:)?child_process["']\s*\)?|\bexecSync\s*\(|\bspawnSync\s*\(|\bexecFileSync\s*\(/,
    patternSource: "\\b(?:require|import)\\s*\\(?\\s*[\"'](?:node:)?child_process[\"']\\s*\\)?|\\bexecSync\\s*\\(|\\bspawnSync\\s*\\(|\\bexecFileSync\\s*\\("
  },
  {
    id: "node-dynamic-eval",
    severity: "block",
    languages: ["node"],
    language: "node",
    shell: "node",
    scope: "command",
    title: "Dynamic code evaluation",
    description: "The script evaluates a string as code at runtime.",
    message: "Dynamic code evaluation",
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*["'`]/,
    patternSource: "\\beval\\s*\\(|\\bnew\\s+Function\\s*\\(|\\bFunction\\s*\\(\\s*[\"'`]"
  },
  {
    id: "node-remote-payload",
    severity: "warn",
    languages: ["node"],
    language: "node",
    shell: "node",
    scope: "command",
    title: "Remote payload download",
    description: "The script downloads a payload over the network.",
    message: "Remote payload download",
    pattern: /\b(?:fetch|axios|got|request)\s*\(|\bhttps?\.(?:get|request)\s*\(/,
    patternSource: "\\b(?:fetch|axios|got|request)\\s*\\(|\\bhttps?\\.(?:get|request)\\s*\\("
  },
  {
    id: "node-permission-weakening",
    severity: "warn",
    languages: ["node"],
    language: "node",
    shell: "node",
    scope: "command",
    title: "Permission weakening",
    description: "The script weakens file permissions.",
    message: "Permission weakening",
    pattern: /\bchmod\s*\(\s*[^,]+,\s*0o?777\s*\)|\bfs\.chmodSync\s*\([^,]+,\s*0o?777/,
    patternSource: "\\bchmod\\s*\\(\\s*[^,]+,\\s*0o?777\\s*\\)|\\bfs\\.chmodSync\\s*\\([^,]+,\\s*0o?777"
  }
];

/**
 * The complete rule pack.
 *
 * `patternSource` is derived from the compiled regular expression so the
 * documented source can never drift away from the pattern that is executed.
 */
export const DANGEROUS_COMMAND_RULES = Object.freeze(
  RULE_CATALOGUE.map(rule => Object.freeze({
    ...rule,
    patternSource: rule.pattern.source
  }))
);

/** Rules used by `skill-source-review.mjs`. */
export const SOURCE_REVIEW_COMMAND_RULES = Object.freeze(
  DANGEROUS_COMMAND_RULES.filter(rule => rule.scope === "source-review")
);

/** Rules used by `skill-manifest.mjs`. */
export const MANIFEST_COMMAND_RULES = Object.freeze(
  DANGEROUS_COMMAND_RULES.filter(rule => rule.scope === "manifest")
);

/** Rules that describe a single command, grouped by shell family. */
export const COMMAND_RULES = Object.freeze(
  DANGEROUS_COMMAND_RULES.filter(rule => rule.scope === "command")
);

/** Lookup table keyed by rule id. */
export const DANGEROUS_COMMAND_RULE_BY_ID = Object.freeze(
  Object.fromEntries(DANGEROUS_COMMAND_RULES.map(rule => [rule.id, rule]))
);

/**
 * Compiles the rules of one scope into executable regular expressions.
 *
 * @param {"command"|"source-review"|"manifest"} scope Rule scope to compile.
 * @returns {{id: string, pattern: RegExp, rule: object}[]}
 */
export function compileDangerousCommandRules(scope) {
  return DANGEROUS_COMMAND_RULES
    .filter(rule => rule.scope === scope)
    .map(rule => ({ id: rule.id, pattern: rule.pattern, rule }));
}

/**
 * Finds one rule by id.
 *
 * @param {string} id Rule identifier.
 * @returns {object|null} The rule, or null when the id is unknown.
 */
export function findDangerousCommandRule(id) {
  return DANGEROUS_COMMAND_RULE_BY_ID[id] ?? null;
}

/**
 * Maps a shell family to the language its rules are reported under.
 *
 * @param {string} shell Shell family name.
 * @returns {string|null} The language name, or null for an unknown shell.
 */
export function languageForShell(shell) {
  return SHELL_LANGUAGE[shell] ?? null;
}

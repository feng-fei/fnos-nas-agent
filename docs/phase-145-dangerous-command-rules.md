# Phase 145 — Dangerous command rule pack and command safety scanner

## 1. Purpose

Phase 103 added a static scan of imported Skill source code
(`apps/fnos-nas-agent/app/skill-source-review.mjs`), and Phase 11 added a
static scan of the Skill manifest (`apps/fnos-nas-agent/app/skill-manifest.mjs`).
Both analysers look for the same class of thing — *text that describes a
dangerous operation* — but they did not share any code:

* `skill-source-review.mjs` owned an inline table of eleven regular
  expressions (`RULES`),
* `skill-manifest.mjs` owned two more inline regular expressions,
* and neither of them could be reused for a command that the agent is about to
  propose to a user.

That left three concrete problems:

1. **Duplicated knowledge.** The same idea — "this text pipes a download into a
   shell" — was written down twice, in two files, with two different
   expressions. Fixing one of them meant remembering the other.
2. **No shell classification.** The existing rules answered *is this text
   dangerous?*, but not *is this dangerous **for this shell**?*. A rule about
   `Remove-Item -Recurse` is meaningless for a Python snippet, and a rule about
   `os.system` is meaningless for a PowerShell script.
3. **No reusable scanner.** When the agent core wants to vet a command before
   it is offered, there was nothing to call: the two analysers are bound to
   their archive and manifest contexts and return findings in their own shapes.

This phase introduces a single data-driven rule pack and a scanner on top of
it, and moves the two existing analysers onto that pack **without changing a
single finding identifier, message or ordering**.

## 2. Threat model

| Threat | Mitigation | Where |
| --- | --- | --- |
| Imported Skill code reaches for a shell execution API | `shell-execution-api` blocks the match | source review |
| Imported Skill code evaluates strings as code | `dynamic-code-evaluation` blocks the match | source review |
| A download is piped straight into an interpreter | `download-piped-to-shell` and the per-shell variants block the match | source review + command |
| Privileges are escalated, possibly over downloaded code | `privilege-escalation-command`, `bash-sudo-downloaded-code` | source review + command |
| The host is destroyed: root delete, raw disk write, format, shutdown | per-shell destructive rules | command |
| Credentials or key material are read or exfiltrated | `credential-or-private-key-path`, `private-key-material`, `cloud-access-key-id`, `github-token-pattern`, `hardcoded-secret-assignment`, `package-registry-token`, per-shell secret-read and exfiltration rules | source review + command |
| Persistence is established | `pwsh-startup-persistence`, `pwsh-registry-run-key` | command |
| Security tooling is disabled | `pwsh-antivirus-disable`, `pwsh-execution-policy-bypass` | command |
| Container or cluster isolation is bypassed | `bash-docker-privileged`, `bash-kubectl-destructive` | command |
| Traces are destroyed | `bash-shell-history-tampering` | command |

**Out of scope by design.** This phase adds *detection*, never *enforcement*.
The scanner is advisory: a match is a signal for a human or for the agent
core to weigh, not a security certification and not an authorisation. Nothing
in this phase executes a command, resolves a path, touches the file system, or
writes anything.

## 3. Rule catalogue

`apps/fnos-nas-agent/app/dangerous-command-rules.mjs` exports a single frozen
array, `DANGEROUS_COMMAND_RULES`. Every rule has the same shape:

| Field | Meaning |
| --- | --- |
| `id` | stable identifier; never reused for a different meaning |
| `severity` | `"block"`, `"warn"`, `"review"` or `"info"` |
| `languages` | the languages the rule applies to (`shell`, `powershell`, `python`, `node`) |
| `language` | the primary language a hit is reported under |
| `shell` | the shell family the rule belongs to (`bash`, `pwsh`, `python`, `node`) |
| `title` | short human readable label |
| `description` | why the pattern is dangerous |
| `message` | the text used when the rule is reported |
| `pattern` | the compiled `RegExp` that is matched against text |
| `patternSource` | the source of `pattern`, derived from it so the two cannot drift |
| `scope` | `"command"`, `"source-review"` or `"manifest"` |

55 rules in total: 41 `block`, 10 `warn`, 3 `review`, 1 `info`.
By scope: 42 `command`, 11 `source-review`, 2 `manifest`.
By shell family: 29 bash, 11 pwsh, 10 python, 5 node.

### 3.1 Historical rules (unchanged)

The eleven `skill-source-review.mjs` rules and the two `skill-manifest.mjs`
rules were migrated verbatim — same identifiers, same regular expressions,
same flags, same relative order:

* source review: `shell-execution-api`, `dynamic-code-evaluation`,
  `download-piped-to-shell`, `privilege-escalation-command`,
  `destructive-system-command`, `credential-or-private-key-path`,
  `private-key-material`, `cloud-access-key-id`, `github-token-pattern`,
  `hardcoded-secret-assignment`, `package-registry-token`
* manifest: `potentially-dangerous-command-text`, `execution-related-text`

Because the expressions are identical, the findings those two analysers
produce are identical too: same identifiers, same `"<rule>: <entry name>"`
message shape for source review, same `manifest` finding identifiers, same
ordering.

### 3.2 Command rules

**bash** — `bash-recursive-delete-root`, `bash-wildcard-delete`,
`bash-fork-bomb`, `bash-raw-disk-write`, `bash-filesystem-format`,
`bash-system-shutdown`, `bash-world-writable-permission`,
`bash-user-account-management`, `bash-sudo-downloaded-code`,
`bash-download-piped-to-shell`, `bash-reverse-shell`, `bash-port-forward`,
`bash-secret-file-read`, `bash-environment-exfiltration`,
`bash-docker-privileged`, `bash-kubectl-destructive`, `bash-git-destructive`,
`bash-shell-history-tampering`

**pwsh** — `pwsh-recursive-delete-root`, `pwsh-filesystem-format`,
`pwsh-system-shutdown`, `pwsh-invoke-expression`,
`pwsh-download-piped-to-shell`, `pwsh-execution-policy-bypass`,
`pwsh-antivirus-disable`, `pwsh-startup-persistence`, `pwsh-registry-run-key`,
`pwsh-credential-read`, `pwsh-remote-execution`

**python** — `python-inline-eval`, `python-os-system`,
`python-subprocess-shell`, `python-pickle-loads`, `python-base64-exec`,
`python-recursive-delete`, `python-secret-file-read`,
`python-network-download`, `python-ctypes-write`

**node** — `node-child-process-exec`, `node-dynamic-eval`,
`node-remote-payload`, `node-permission-weakening`

## 4. Behaviour

### 4.1 The scanner

`apps/fnos-nas-agent/app/command-safety-scanner.mjs` exports:

```js
scanCommand(text, { language } = {})   // → { findings, highestSeverity, verdict, matched, language, shell }
scanText(text)                         // → the same shape, whole pack, language "any"
```

`scanCommand` resolves the language in this order:

1. an explicit `language` that is one of `shell`, `powershell`, `python`,
   `node` wins;
2. otherwise the language is detected from the command text — `pwsh`,
   `powershell` or `cmd /c` → `powershell`; `python` or `py` → `python`;
   `node` → `node`; anything else → `shell`.

The rules are then filtered to that language, except the historical
source-review and manifest rules, which apply to every language because they
describe text patterns rather than a shell dialect.

The result object:

| Member | Contract |
| --- | --- |
| `findings[]` | `{ id, severity, message, language, excerpt }` — one entry per matched rule, deduplicated by rule id |
| `highestSeverity` | the strictest severity in `findings`, or `null` |
| `verdict` | `"block"` if any finding is `block`; `"warn"` if any finding is `warn` or `review`; otherwise `"allow"` |
| `matched[]` | `{ id, shell, title, description, severity, language }` — the rule metadata behind each finding |
| `language` | the language the scan was performed for (`"any"` for `scanText`) |
| `shell` | the same value; kept for callers that speak in shells |

`scanText` applies the whole pack regardless of language and reports
`language: "any"`.

### 4.2 Bounded output

The scanner never returns the input:

* the input is truncated to 256 KiB before matching,
* at most 100 findings are produced,
* every `excerpt` is the matched text only, with whitespace collapsed and
  truncated to 80 characters (`…` marks a truncation).

A finding therefore never becomes a channel for smuggling the rest of a file
into a log or a model context.

### 4.3 The two existing analysers

`skill-source-review.mjs` now builds its rule table from the pack:

```js
import { SOURCE_REVIEW_COMMAND_RULES } from "./dangerous-command-rules.mjs";
const RULES = SOURCE_REVIEW_COMMAND_RULES.map(item => [item.id, item.pattern]);
```

`skill-manifest.mjs` does the same for its two manifest rules:

```js
import { MANIFEST_COMMAND_RULES } from "./dangerous-command-rules.mjs";
for (const rule of MANIFEST_COMMAND_RULES) {
  if (rule.pattern.test(content)) findings.push(rule.id);
}
```

Both keep their previous exports, their previous findings, their previous
ordering and their previous caps.

## 5. What did not change

* **No shell execution was enabled.** The agent still never runs an arbitrary
  command; the scanner only matches text.
* **Imported Skill code is still never executed.** The pack is data, not a
  loader.
* **Findings remain advisory.** A `block` severity is a strong signal, not an
  authorisation decision.
* **The existing finding identifiers are unchanged**, so the review UI, the
  audit log and the existing tests keep working against the same strings.
* **No dependency was added.** Both modules use only Node.js built-ins.

## 6. Tests

`tests/phase-145-dangerous-command-rules.test.mjs` covers:

* the shape of the pack — every rule has an id, a known severity, known
  languages, a known shell, a title, a description, a message and a compiled
  pattern; identifiers are unique and resolvable;
* the enumerations and the strict, stable severity ordering;
* that the eleven source-review and two manifest identifiers and their
  regular expressions are byte-identical to the historical ones;
* that each of the four shell families has a rule that fires on a sample
  command, and that a benign command is allowed;
* the result structure — id, severity, message, language, excerpt, and the
  `matched[]` metadata;
* that the excerpt is bounded and whitespace-collapsed, so a long input is
  truncated rather than echoed;
* that the scanner and the pack contain no process execution: no
  `child_process`, no `execSync`/`spawnSync`/`execFileSync`, no `node:vm`;
* that `skill-source-review.mjs` and `skill-manifest.mjs` both import the
  shared pack and use its rule collections.

## 7. Known limits

* **Regular expressions are not a parser.** The rules match text; a payload
  that is assembled at runtime is invisible to them. The pack is a triage
  aid, not a sandbox.
* **Language detection is a heuristic.** `scanCommand` guesses the shell from
  the command text when the caller does not say; an unusual wrapper can make
  the guess wrong. Callers that know the shell should pass it.
* **One rule matches at most once.** A rule that fires twice is reported
  once; the excerpt shows the first match.
* **The historical manifest rules are intentionally broad.** They are word
  level heuristics over a free-form text file, so they produce advisory
  findings, not verdicts.
* **The pack is a snapshot.** New attack shapes need new rules; nothing
  infers them from the input.

## 8. Integration points (suggested, not applied here)

This phase does not wire the scanner into any request path. The intended
integration points for the agent core are:

1. **Before a tool call is proposed.** When the agent core assembles
   `toolCall.args` for a shell or file command, run `scanCommand` over the
   command text and refuse or escalate on `verdict === "block"`.
2. **Before a Skill is marked reviewed.** `skill-source-review.mjs` and
   `skill-manifest.mjs` already consume the pack; the agent core can reuse
   `COMMAND_RULES` for the command-bearing parts of a Skill.
3. **In the audit log.** `matched[].id` is a stable identifier and can be
   recorded as a risk class next to the tool call, without recording the
   command text itself.

Until those connections exist, this phase changes no runtime behaviour: it
only replaces two inline rule tables with one shared source and adds a
scanner nobody calls yet.

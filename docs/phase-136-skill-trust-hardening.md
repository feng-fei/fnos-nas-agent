# Phase 136 — Skill Trust Hardening

The Skill domain let the client decide what the server later trusted. A caller
could post a registration whose `manifestReview` claimed a clean static review,
and the server stored that claim as if it had performed it. The same client
could also point the record at a quarantine file of its choosing, and the
installer used a name comparison to decide that an archive was "official". A
read-only audit of the implementation found seven places where a decision that
belongs to the server was made by the request.

This phase moves every one of those decisions back to the server and closes the
loopholes that follow from them.

## Defect 1 — The client declared its own review verdict

`register()` in `apps/fnos-nas-agent/app/skills.mjs` copied
`input.manifestReview` and `input.quarantineFile` straight into the stored
record, and `POST /api/skills` hands the whole request body to that function.
The stored `manifestReview` was later the only evidence the system had that a
Skill had been statically reviewed: `transition()` only checked the state
machine, and `installCli()` decided "official fnOS Skill" from
`record.manifestReview?.name?.toLowerCase() === "fnos"`.

An attacker with access to the local API could therefore post

```json
{ "name": "fnos", "manifestReview": { "name": "fnos", "status": "manifest_parsed", "findings": [] } }
```

and get a record that the rest of the system treated as a reviewed, official
Skill, backed by any archive the attacker chose to point at.

**Fix.** `register()` now ignores both fields completely
(`apps/fnos-nas-agent/app/skills.mjs:168-238`):

- The quarantine path is derived by the server from the archive digest:
  `skill-quarantine/<sha256>.zip` in lower case hex
  (`apps/fnos-nas-agent/app/skills.mjs:184-185`). The client cannot point the
  record at a different file.
- The quarantined archive must exist before a Skill can be registered. The
  lookup goes through `readQuarantinedArchiveForReview()`
  (`apps/fnos-nas-agent/app/skills.mjs:256-286`), which applies the same
  confinement checks as the archive reader used later: the resolved path must
  stay inside the quarantine root, the entry must be a regular file and not a
  symbolic link, and the SHA-256 of the bytes must equal the digest in the
  record. A missing archive fails the registration with
  `409 A quarantined Skill archive is required to register a Skill`
  (`apps/fnos-nas-agent/app/skills.mjs:266`).
- The review verdict is computed on the spot from the archive bytes with
  `inspectSkillManifest(buffer)` and carries two new server-owned markers,
  `reviewedBy: "server"` and `archiveSha256`
  (`apps/fnos-nas-agent/app/skills.mjs:191-195`). If the archive cannot be
  read safely, the review is recorded as `null` — the record stays
  unapproved and uninstallable instead of carrying a fabricated "clean" verdict.
- `normalizeManifestReview()` keeps the two new fields and validates them:
  `reviewedBy` is only preserved when it is exactly the string `"server"`, and
  `archiveSha256` only when it matches `/^[a-f0-9]{64}$/`
  (`apps/fnos-nas-agent/app/skills.mjs:39-40`). A stored record can therefore
  never claim a server review that the server did not write.
- `importArchive()` no longer computes or forwards a review of its own; the
  registration path is the single place where the verdict is produced. The
  returned shape (`{ ...record, archiveEntries }`) is unchanged.

## Defect 2 — Approval did not require a review

`transition()` only validated the state machine, so a record whose review was
missing or fabricated could still be moved from `pending_review` to `approved`.

**Fix.** Moving a Skill to `approved` now requires a server-owned review
(`apps/fnos-nas-agent/app/skills.mjs:425-428`). A record with no review, or
with a review that is not marked `reviewedBy: "server"`, is refused with
`409 A server-side static review is required before approving this Skill`.

## Defect 3 — The installer trusted a name comparison

`installCli()` in `apps/fnos-nas-agent/app/skill-installer.mjs` treated a
record as the official fnOS Skill when its review said the name was `fnos`.
Combined with defect 1 that made "official" a client-chosen property.

**Fix.** The installer now requires proof that the server reviewed *this*
archive (`apps/fnos-nas-agent/app/skill-installer.mjs:47-50`):

- `record.manifestReview.reviewedBy` must be `"server"`, and
- `record.manifestReview.archiveSha256` must equal `record.archiveSha256`.

Otherwise the installation is refused with
`403 The Skill was not reviewed by the server; re-import the archive before
installing its CLI`. The manifest is still re-parsed from the archive on the
spot, the ELF header of the binary is still validated, and the archive must
now also contain the `fnos/bin/trim-cli-linux-x64` (or `...-arm64`) entry
itself (`apps/fnos-nas-agent/app/skill-installer.mjs:85-88`, the entry check
before `extractZipEntry`). The result object reports `reviewedBy: "server"`
and `archiveSha256` so that the audit trail states where the verdict came
from (`apps/fnos-nas-agent/app/skill-installer.mjs:119-120`).

## Defect 4 — Skill names were only unique per archive

De-duplication compared the name *and* the digest, so `fnos` and `FNOS` could
both exist in the inventory. The API that selects the official CLI then picks
the first enabled record whose name matches `fnos` case-insensitively, so the
winner depended on registration order.

**Fix.** `register()` now rejects a duplicate name case-insensitively across
the whole inventory, regardless of digest
(`apps/fnos-nas-agent/app/skills.mjs:178-180`):
`409 Skill name already registered`.

## Defect 5 — Unscanned binary entries counted as a clean review

The static source review only looked at text files with known extensions.
Everything else in the archive was silently ignored, and an archive whose
findings list was empty was reported as `manifest_parsed` — the same status as
a thoroughly reviewed text-only Skill. Dropping an executable into the archive
therefore produced a "reviewed, zero findings" verdict.

**Fix.** `inspectSkillSource()` now walks the archive entries and reports
every entry that is neither a directory nor a previewable text file
(`apps/fnos-nas-agent/app/skill-source-review.mjs:84-97`):

```
unreviewed-binary-entry: assets/payload.bin
```

Such an archive is reported with status `needs_review` instead of
`completed`/`manifest_parsed`. The existing cap of 20 findings and the
existing finding text format are unchanged.

## Defect 6 — The batch download budget ignored failed downloads

`importGitHubSkillBatch()` added the size of an archive to the running total
only after the download had succeeded and had been imported. A download that
failed after transferring bytes was not charged, so a batch of failing
downloads could transfer several times the configured budget.

**Fix.** The batch importer charges the budget with the bytes that were
actually read, for failures as well as successes
(`apps/fnos-nas-agent/app/skill-remote-import-batch.mjs:13-27`):

- `readTransferredBytes()` takes the byte count from the error
  (`bytesRead`, `downloadedBytes`, `bytes`, `transferredBytes`) or from the
  partial archive, and the total is increased even when the entry fails.
- When a read-stage failure (too large, read error, `413`) leaves the
  transferred size unknown, the remaining budget for the batch is voided at
  once instead of allowing the next entries to keep downloading.
- `413` and `SKILL_REMOTE_TOO_LARGE` still mean "the download budget is
  exhausted", as before.

## Defect 7 — Local failures were reported as remote failures

The batch importer replaced every failure with the generic text "Unable to
import this GitHub Skill archive." A local failure — for example the
quarantine storage refusing to run without Linux directory descriptors, or the
inventory refusing to persist metadata — was therefore reported as a problem
with the remote archive, sending the operator in the wrong direction.

**Fix.** Only errors whose `code` starts with `SKILL_REMOTE_` are treated as
remote failures and recorded per entry. Every other error is re-thrown
unchanged, keeping its original message and `statusCode`
(`apps/fnos-nas-agent/app/skill-remote-import-batch.mjs:114-140`).

## Defect 8 — A `.git` suffix broke the GitHub API request

`validateGitHubRepositoryUrl()` accepted `owner/repo.git` and kept the suffix,
so the commit lookup was built as
`https://api.github.com/repos/owner/repo.git/commits/<ref>`, which can only
fail with a 404.

**Fix.** `normalizeRepositoryName()` strips a trailing `.git` before any URL
is built (`apps/fnos-nas-agent/app/skill-remote-import.mjs:14-25`,
used at `:59` and `:80`). The `owner/repo` shape validation and the rest of
the checks are unchanged.

## Threat model after this phase

| Before | After |
| --- | --- |
| The client declared the review verdict | The verdict is computed by the server from the quarantined bytes and marked `reviewedBy: "server"` |
| The client chose the quarantine file | The path is derived from the digest and the bytes are hash-checked |
| A record could be approved without any review | Approval requires a server-owned review |
| "Official" was a name comparison in the installer | The installer requires a server review of the same archive digest |
| `fnos` and `FNOS` could coexist | Names are unique case-insensitively across the inventory |
| An archive with an unexamined executable was "reviewed, 0 findings" | Unscanned entries are reported as `unreviewed-binary-entry` and force `needs_review` |
| A failing download did not consume the budget | Transferred bytes are charged, and an unmeasurable read voids the rest of the budget |
| Local errors were reported as remote errors | Only `SKILL_REMOTE_*` errors are treated as remote failures |
| `owner/repo.git` produced a guaranteed 404 | The suffix is normalized before the request is built |

The remaining trust boundary is unchanged in one important respect: the
"official fnOS Skill" identity still rests on the operator supplying the
correct archive. There is no signature verification and no publisher
certificate chain in this phase. The server now guarantees that *what it
reviewed* is the archive it stored, that the review was performed by the
server, and that the reviewed bytes are the bytes that get installed — but it
cannot yet prove that an archive came from fnOS rather than from anyone who
can produce a well-formed ZIP.

Other limits that remain:

- The static review is a text and structure review. It reads manifests, source
  and configuration files, and it flags unscanned binaries, but it does not
  execute or disassemble them.
- Findings are capped at 20 entries per review, and the review is performed
  once, at registration time. A Skill that is re-imported with the same digest
  is not re-reviewed.
- The official CLI is installed from the reviewed archive, but the ELF check
  verifies the header and the machine type only, not the behaviour of the
  binary.

## Verification

`tests/phase-136-skill-trust-hardening.test.mjs` covers each defect: a
fabricated `manifestReview` is ignored in favour of the server's own verdict,
a registration without a quarantined archive is refused, `fnos` and `FNOS`
collide, a record without a server review cannot be approved, the installer
refuses a record the server did not review (and a review that belongs to a
different archive), an unreviewed binary entry produces a finding, the batch
budget is charged for failed downloads, a local failure keeps its own message
and status code, and a `.git` suffix is normalized without issuing a request.

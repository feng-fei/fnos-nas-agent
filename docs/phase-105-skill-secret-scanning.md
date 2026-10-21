# Phase 105 — Embedded credential and key scanning for Skills

Extends the bounded Phase 103 source scan to flag credential-like material in Skills before approval.

- Recognizes common AWS access-key IDs, GitHub personal/repository token prefixes, package registry auth tokens, private-key PEM markers, and long literal assignments to common credential fields.
- Includes common config files such as `.env`, `.env.example`, `.npmrc`, and `.pypirc`, in addition to supported source/config extensions.
- Results contain only the rule identifier and archive path. Matched token/key values and source lines are never persisted in findings or review metadata.
- Findings are advisory and leave the existing Skill in `pending_review`; they do not automatically reject the Skill or certify it as safe.
- The scan stays within the existing 32-file, 64 KiB per file, 512 KiB total source budget and does not extract files to disk or execute imported code.

Validation: test fixtures include fake token/key strings and assert that the values are absent from serialized findings and manifest review. No real secrets, external services, or NAS are used.

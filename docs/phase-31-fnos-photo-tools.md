# Phase 31 — Practical fnOS Photo Search and Capability Checks

## Delivered

- Add the official Skill-documented `photos folders` command as a read-only tool.
- Add keyword-based `photos search <keyword> --limit N` with a required keyword and a bounded result limit (1–50, default 20).
- Add `monitor beep-supported` to query capability support only; this command does not trigger a beep.
- Route common Chinese requests such as “查看相册文件夹” and “搜索照片 家庭旅行” directly to these tools without requiring a model API.
- Keep the fixed argv allowlist, shell-free process invocation, output bounds, timeout handling, and stderr suppression.
- Add adapter and registry regression tests for command mapping, argument validation, and read-only tool metadata.

## Scope and limitations

- Command names and syntax are taken from the supplied official fnOS Skill's documented common read-only commands.
- Photo search may require a photo-related OAuth scope. If the active profile lacks that scope, the user must complete the official interactive authorization flow; the Agent must not handle authorization codes or tokens.
- The Agent returns bounded CLI data; actual result fields and device behavior still need validation against a test fnOS NAS.
- No write commands, arbitrary `raw` requests, Media APIs, or automatic login behavior are added.

## Acceptance

- Node.js 24 and 26 test suites and FPK packaging pass.
- Photo search rejects blank/oversized keywords, unknown arguments, and limits outside 1–50 before spawning the CLI.
- No real NAS was modified as part of CI validation.

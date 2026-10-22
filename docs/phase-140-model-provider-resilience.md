# Phase 140 — Model provider resilience

Phase 133 made the backup providers reachable. A read-only audit of the model path
found ten remaining defects in the same area: a disabled primary provider could not
hand over to a backup, two format errors were neither retried nor degraded, the
managed store could hide the environment configuration, a single damaged record
could take every provider down, and the metrics could not say how many HTTP
attempts a request really cost.

This phase repairs those ten defects in `model-adapter.mjs` and
`model-provider-store.mjs`. It changes no public endpoint, no file format and no
server route.

## 1. The ten defects, quantified

| # | Defect | Trigger | Effect before | Effect now |
| --- | --- | --- | --- | --- |
| 1 | Primary provider unusable → no request at all | primary disabled, or missing endpoint / key / model | `plan()` returned `null`; the user saw "no model configured" although a working backup existed | the first usable backup takes over as the primary (`model-adapter.mjs:260-280`) |
| 2 | Disabling the active provider emptied the main slot | `store.update(id, { enabled: false })` | `activeProviderId` became `null`; the managed configuration disappeared | the slot moves to another enabled provider with a key, exactly like a removal (`model-provider-store.mjs:301`) |
| 3 | Format errors were final | provider answered `200` with a non-JSON or oversized body | `MODEL_INVALID_RESPONSE` / `MODEL_RESPONSE_TOO_LARGE` broke the candidate loop without a retry | both are `retryable` and `fallbackEligible`; `MODEL_INVALID_PLAN` stays a hard failure (`model-adapter.mjs:85-101`) |
| 4 | A placeholder object hid the environment configuration | store loaded but no qualified active provider | `runtimeConfig()` returned `{ enabled: false }`; `server.mjs` (`managed \|\| modelConfiguration()`) never read the environment variables | `runtimeConfig()` returns `null`, so the environment configuration is used again (`model-provider-store.mjs:256-265`) |
| 5 | An update could re-enable a disabled provider | `store.update(id, { name: "new name" })` without an `enabled` field | `enabled` defaulted to `true` | the current state is kept (`model-provider-store.mjs:119,135,292`) |
| 6 | One damaged record disabled every provider | a single stored record failed validation | the whole store answered `503`; `list()` failed, so the user could not repair anything | the damaged record is skipped, the rest stay usable, and the repaired file is written back (`model-provider-store.mjs:202-254`) |
| 7 | Primary and backup used different de-duplication keys | primary and backup pointed at the same provider | the same provider was called twice | one rule for both: provider id **and** endpoint + model (`model-adapter.mjs:70-77,264-278`) |
| 8 | The aggregate error kept only the last candidate | every candidate failed | the root cause was hidden behind the last status code | the primary failure is thrown, and every candidate failure travels with it as a list (`model-adapter.mjs:494-529`) |
| 9 | Failed requests lost their tokens | provider answered, then the plan was unusable | the usage was never counted | the usage is counted as soon as the envelope is parsed, before the plan is built (`model-adapter.mjs:382-385`) |
| 10 | The metrics could not express the HTTP cost | any request | `attempts` mixed candidate and HTTP counts, `averageLatencyMs` included the backoff sleep | `httpAttempts`, `maxHttpAttempts`, a wall-clock latency without the backoff and the accumulated attempt latency are added next to the untouched legacy counters (`model-adapter.mjs:164,187-193,455-468`) |

## 2. What was changed, item by item

### 2.1 An unusable primary provider hands over to a backup

`isUsableConfig()` (`model-adapter.mjs:60-66`) defines one rule — enabled, plus a
non-empty endpoint, key and model — and `buildCandidates()` (`:260-280`) uses it for
the primary, for every backup and for the status report, so the three can never
disagree. A primary that does not satisfy the rule is not the end of the list: the
first backup that does satisfy it becomes the primary candidate and carries the
request. `status()` (`:432-449`) reports that candidate as `providerId` /
`providerName` and counts the remaining ones as `fallbackProviders`, so the status
report finally matches what the agent can actually do.

`model-provider-store.mjs:301` closes the other half of the same defect: disabling
the active provider now moves the main slot to another enabled provider that has a
key, using the same rule as `remove()` (`:312`). The previous behaviour — an empty
slot — is what made the managed configuration disappear from `runtimeConfig()`.

### 2.2 Format errors are retried and degraded; a broken plan is not

The three format failures are now separated by cause:

| Error code | Cause | `retryable` | `fallbackEligible` |
| --- | --- | --- | --- |
| `MODEL_INVALID_RESPONSE` | the body is not JSON, or the plan text is missing or not bounded | yes | yes |
| `MODEL_RESPONSE_TOO_LARGE` | the answer exceeds the 64 KiB response or the 16 KiB plan bound | yes | yes |
| `MODEL_INVALID_PLAN` | the JSON is valid but breaks the plan contract (message length, tool count, unknown tool, wrong argument shape) | no | no |
| `MODEL_REQUEST_ABORTED` | the caller cancelled the request | no | no |

A provider that answers with an unusable body is worth one more try and worth
asking the next provider. A structured plan that does not match the contract would
come back the same way from every provider, so it is not repeated and not degraded.

`MODEL_REQUEST_ABORTED` is new. It ends the whole call: the candidate loop breaks
on it (`model-adapter.mjs:508`) and the next provider is never asked, because a
cancelled request is a decision of the caller, not a provider problem.

### 2.3 The managed store no longer hides the environment configuration

`server.mjs` resolves the model configuration as `managed || modelConfiguration()`.
A placeholder object is truthy, so the old `{ enabled: false }` return value of
`runtimeConfig()` silently swallowed the environment configuration
(`AGENT_MODEL_ENDPOINT` / `AGENT_MODEL_API_KEY` / `AGENT_MODEL_NAME`).

`runtimeConfig()` (`model-provider-store.mjs:256-265`) now returns `null` when
there is no qualified active provider: the store is not loaded, the store is
degraded, there is no provider at all, or the active provider is disabled or has
no key. `server.mjs` is **not** modified — the `||` fallback it already had does
the right thing once the placeholder is gone.

### 2.4 An update keeps the current enabled state

`validateModelProviderInput()` accepts a `currentEnabled` flag and defaults
`enabled` to it (`model-provider-store.mjs:119,135`); `update()` passes the current
value (`:292`). Renaming a provider or changing its model therefore no longer
switches a disabled provider back on. The `fallback` field already had this
protection and is unchanged.

### 2.5 One damaged record no longer disables the whole store

`load()` (`model-provider-store.mjs:202-254`) now validates every record on its
own. `normalizeProviderRecord()` (`:101-117`) rejects a record that does not match
the storage contract, and the loop (`:213-235`) skips it, counts it and writes a
diagnostic to the log. Duplicate ids are skipped the same way. When at least one
record was skipped, the repaired file is written back on a best-effort basis
(`:244-246`).

Two states are explicitly **not** treated as damage:

- An active provider that is disabled is a normal user state. The main slot falls
  back to `null` (`:236-241`) instead of raising "Default provider is disabled".
- A secret that cannot be decrypted is a key failure, not a damaged record. The
  decryption error still escapes the loop (`:231`), the store reports
  `503 MODEL_STORE_UNAVAILABLE` (`:247-251`) and no provider is served with a
  guessed key. This distinction is the reason the per-record `try`/`catch` wraps
  the record validation only, not the decryption.

### 2.6 One de-duplication rule for the primary and the backups

`candidateTokens()` (`model-adapter.mjs:70-77`) gives every candidate the tokens
`id:<providerId>` and `endpoint:<endpoint>\n<model>`. The primary candidate seeds
the token set, and a backup is skipped when it repeats **any** of those tokens
(`:264-278`). A backup that points at the same endpoint and model as the primary
is therefore recognised even when the two records carry different provider ids,
and a backup with the same provider id is recognised even when its endpoint text
differs. The old `providerId` key and the old `endpoint + "\n" + model` key are
both gone, along with the literal `"primary"` key that made the status report and
the request path disagree.

The candidate list is no longer truncated twice: the store hands out at most three
backups, and the adapter accepts up to `MAX_FALLBACK_CANDIDATES = 8` candidates
(`:10,277`), so an injected list is not silently shortened twice.

### 2.7 The aggregate error keeps the primary failure

`plan()` collects every candidate failure (`:494-511`) and throws the **first**
one — the failure of the provider the user configured — with the `statusCode` it
carried, plus a `failures` list that names every candidate, its code, its
category and its status (`:512-529`). The caller still sees one error, but the
root cause is no longer replaced by the last candidate's status code, and
`agent-core.mjs` keeps classifying the error from the primary status.

### 2.8 Failed requests keep their token usage

The usage of the response envelope is added to the metric before the plan is
built (`model-adapter.mjs:382-385`). A provider that answered and was then paid
for no longer disappears from the token counters, which is what the usage-based
cost view needs.

### 2.9 The metrics tell the truth about HTTP

The legacy counters keep their exact meaning: `totals` still holds
`requests, attempts, retries, successes, failures, inputTokens, outputTokens,
totalTokens` and nothing else (`:455-459`), so the existing UI, which reads
`data.metrics.totals`, keeps working unchanged. The new HTTP view is reported
next to them:

| Field | Where | Meaning |
| --- | --- | --- |
| `http.httpAttempts` | `metrics().http` | the number of requests that really left the process |
| `http.maxHttpAttempts` | `metrics().http` | the largest number of HTTP attempts one request needed |
| `http.maxHttpAttemptsPerRequest` | `metrics().http`, `status()` | the configured ceiling of one candidate (the same value as `maxAttempts`) |
| `http.wallClockLatencyMs` | `metrics().http` | the provider time, without the backoff sleep |
| `http.totalAttemptLatencyMs` | `metrics().http` | the accumulated latency of every attempt, including the backoff sleep |
| `providers[].httpAttempts`, `providers[].maxHttpAttempts`, `providers[].wallClockLatencyMs`, `providers[].lastWallClockLatencyMs`, `providers[].totalAttemptLatencyMs` | `metrics().providers[]` | the same values per provider |

`status()` also reports the two ceilings of one user request
(`model-adapter.mjs:432-449`): `maxHttpAttemptsPerRequest` is the ceiling of a
single candidate, `maxHttpAttemptsPerUserRequest` is the ceiling of the whole
request (the candidate count times `maxAttempts`) and
`maxHttpAttemptsPerUserRequestCap` is the ceiling of the candidate list
(`MAX_FALLBACK_CANDIDATES + 1` candidates times `maxAttempts`). The two latency
views are reported next to each other: `wallClockLatencyMs` is the time the
provider actually took, `totalAttemptLatencyMs` is the same time plus the
backoff sleep the adapter asked for.

The backoff sleep is measured separately (`:356-358,369-371,403-405`) and
subtracted from the wall-clock latency, so a slow provider is not punished for a
retry delay that the adapter itself asked for. `metric.attempts` still counts the
candidate attempts exactly as before; `httpAttempts` counts the actual HTTP calls
and is incremented only when a request is really sent (`:328-329`).

### 2.10 A request can be cancelled

`plan(userText, tools, history, options)` accepts an optional `options.signal`
(`model-adapter.mjs:476-480`). The signal is combined with the provider timeout
through `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])` (`:332-335`);
without a signal the timeout alone is used, so the previous behaviour is
unchanged. A cancelled request raises `MODEL_REQUEST_ABORTED`
(`:78-82,327`), is not retried and does not move on to the next provider
(`:508`).

## 3. Compatibility

- **`plan()` keeps its old signature.** `plan(userText, tools, history)` is still
  valid: the options object is optional and a missing signal means "no
  cancellation" (`:476-480`). `agent-core.mjs` already calls
  `plan(text, tools, history, signal ? { signal } : {})`.
- **`runtimeConfig()` now returns `null` instead of a placeholder.** Every
  consumer is `server.mjs` (`managed || modelConfiguration()`) and the status
  endpoint, which treats a missing managed configuration as "use the environment
  configuration". The truthiness of the old placeholder was the defect, so the
  change is intentional and the fallback is the documented behaviour.
- **The store file format is unchanged.** The record contract, the encryption
  (`aes-256-gcm`), the file permissions and the atomic write are untouched. A
  repaired file only differs by the records that were dropped.
- **The metrics keep their old fields.** `totals` is unchanged field by field;
  the new HTTP values are additive. The web console reads `data.metrics.totals`
  and needs no change.
- **The public API of the store is unchanged.** `load`, `list`, `runtimeConfig`,
  `runtimeFallbackConfigs`, `add`, `update`, `remove`, `setDefault`, `test`,
  `discoverModels`, `degraded` and `status` keep their signatures and their
  status codes.
- **No server route, tool registry, task engine or UI file was modified.**

## 4. Known limitations

- A provider that answers `400` or `422` is not repeated against the next
  provider: the request body itself is wrong and would fail everywhere. This is
  the behaviour Phase 133 introduced and it is kept.
- `MODEL_INVALID_PLAN` is a hard failure. A provider that returns a valid JSON
  object with a broken plan ends the request instead of trying the next
  provider, because the contract error is not provider specific.
- The store still serves at most three backup providers
  (`model-provider-store.mjs:270`); the adapter accepts more, but the store does
  not produce more.
- The backup order is the order in which the providers were added. There is no
  health score, no latency ranking and no cost ranking; a backup that is first
  in the list is the first one that is asked.
- Every candidate is tried at most `maxAttempts` times (2 by default) and the
  backoff sleep between two attempts of the same candidate is 150 ms and 400 ms.
  A request that walks every candidate can therefore reach
  `candidates × maxAttempts` HTTP requests.
- The static review of an installed Skill and the signature chain of the release
  artifacts are not part of this phase; this phase only repairs the model
  provider path.
- A damaged record is dropped, not repaired. Its API key cannot be recovered and
  the operator has to add the provider again; the repair is written back to disk
  so the store does not fail again on the next start.
- The decryption failure path still closes the whole store
  (`503 MODEL_STORE_UNAVAILABLE`). That is deliberate: without the master key no
  provider can be served, and serving them without a key would be worse.
- The metric counters live in the process memory only, as before; a restart
  resets them.
- The store file permissions are still written as `0600`. On a file system that
  does not support POSIX modes (Windows without a POSIX layer) the mode bits are
  not enforced, which is a platform property and not a behaviour of this phase.

## 5. Test strategy

`tests/phase-140-model-provider-resilience.test.mjs` holds 15 cases, one per
repaired behaviour plus the two compatibility guards. They use an injected fake
`fetch` and a real store in a temporary directory; no network access and no API
key is needed.

| Case | What it proves |
| --- | --- |
| a disabled primary lets a backup serve the request | defect 1, adapter side |
| disabling the active provider moves the main slot | defect 2 |
| an invalid response is retried and then degraded | defect 3 |
| an oversized response is retried and then degraded | defect 3 |
| an invalid plan is neither retried nor degraded | defect 3 |
| a store without a qualified active provider returns `null` | defect 4 |
| an update without `enabled` keeps a provider disabled | defect 5 |
| a damaged record is skipped and the rest stay usable | defect 6 |
| an undecryptable secret still closes the store with `503` | defect 6 |
| the primary and the backups share one de-duplication rule | defect 7 |
| the aggregate error keeps the primary failure and lists the failures | defect 8 |
| a failed request still reports its token usage | defect 9 |
| the HTTP metrics report the attempts, the ceiling and the wall clock | defect 10 |
| a cancelled request reports `MODEL_REQUEST_ABORTED` and does not degrade | new cancellation contract |
| the three argument `plan()` call still works | compatibility |

The suite is run with the Node.js 26 test runner:

```
node --test tests/phase-140-model-provider-resilience.test.mjs
```

The existing suites that cover the same files are run as well:
`tests/phase-19-model-adapter-contract.test.mjs`,
`tests/model-provider-store.test.mjs`, `tests/phase-133-model-fallback-and-scan-bounds.test.mjs`,
`tests/phase-8-agent-core.test.mjs`, `tests/phase-47-conversation-context.test.mjs`,
`tests/phase-91-model-batch-test-ui.test.mjs`, `tests/model-provider-ui.test.mjs`
and `tests/model-provider-api.test.mjs`.

Three assertions in `tests/model-provider-store.test.mjs` described the old
behaviour. They are updated in the working tree to the new contract and now
pass:

| Location | Old expectation | New contract |
| --- | --- | --- |
| `tests/model-provider-store.test.mjs:81` | `store.runtimeConfig().enabled === false` | `store.runtimeConfig()` is `null` |
| `tests/model-provider-store.test.mjs:140` | `store.list().activeProviderId === null` after the default provider is disabled | the other enabled provider (`second.id`) takes the main slot |
| `tests/model-provider-store.test.mjs:147` | `store.runtimeConfig().enabled === false` | `store.runtimeConfig()` is `null` |

One more assertion fails for a platform reason and not because of this phase:
`tests/model-provider-store.test.mjs:48` (and the same check in
`tests/phase-72-model-provider-http-integration.test.mjs:84`) expects the POSIX
mode bits `0600`. On a Windows file system that does not enforce POSIX modes the
bits are `0666` no matter which mode the store writes, so the assertion fails on
Windows and passes on the Linux runtime of the NAS.

The repository documentation index (`docs/README.md`) has to list this document as
a Phase 140 entry and its document count has to be raised by one; the release
gate (`scripts/check-release-gates.mjs:413`) compares the index sentence with
the real number of files in `docs/`.

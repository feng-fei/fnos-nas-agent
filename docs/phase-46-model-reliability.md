# Phase 46 — Model provider reliability and quick setup

## Included

- Common HTTPS OpenAI-compatible Chat Completions presets for OpenAI, DeepSeek, SiliconFlow, and Alibaba Cloud Model Studio (Beijing shared domain), plus a custom endpoint option.
- Presets only fill the provider name and endpoint. Users must enter a model ID valid for their own account and region and supply their own API key. No keys or live model catalog are bundled.
- Model provider records may be explicitly marked as backup models. Only enabled backup models with saved API keys are eligible, up to three per request, after the selected primary returns a transient network, timeout, HTTP 408/425/429, or HTTP 5xx failure. Invalid structured output and ordinary 4xx responses do not automatically switch to another provider.
- The adapter retries transient failures a bounded number of times (two total attempts by default). Retry delay is short and bounded. It never retries invalid tool plans or executes tools before a valid plan has passed the existing allowlist/schema checks.
- In-memory runtime metrics include provider request/attempt/retry counts, successes/failures, success rate, response latency, and token counts when the provider returns usage metadata. Metrics are bounded by provider cardinality and are not persisted.
- The model management API exposes the preset list and aggregate metrics to authenticated sessions. Metrics exclude credentials, endpoint URLs, prompts, tool output and raw provider response bodies.
- The mobile UI exposes quick setup, an explicit backup-model checkbox, and process-lifetime health/usage summaries.

## Backup and retry behavior

Failover is opt-in per provider: checking “备用模型” marks it eligible. A normal enabled provider that is not marked as a backup will never be used as an automatic fallback. Backups are tried in configured list order, with at most three backup candidates. This avoids silently switching to a different paid provider unless the user opted into that behavior.

Transient retries are bounded to avoid loops and uncontrolled provider charges. HTTP authentication/model-not-found errors are not automatically retried or failed over; fix the credentials or model name instead. Provider output that does not match the expected bounded JSON plan is rejected without retry/failover. Tool argument validation and the server-side risk/confirmation policy remain authoritative.

## Metrics

Counters live only in the Node.js process memory and reset when the service restarts. Token figures are reported only when a compatible provider supplies usage fields; they are not inferred from prompt length. Cost is intentionally not estimated because prices and account-specific rates vary. Provider endpoints, API keys, prompts, returned content and tool results are not included in the metrics API.

## Presets and official docs

- OpenAI Chat Completions: https://platform.openai.com/docs/api-reference/chat
- DeepSeek Chat Completions: https://api-docs.deepseek.com/api/create-chat-completion
- SiliconFlow Chat Completions: https://docs.siliconflow.cn/docs/api/chat-completions-post
- Alibaba Cloud Model Studio OpenAI compatibility: https://help.aliyun.com/en/model-studio/compatibility-of-openai-with-dashscope
- Alibaba Cloud Model Studio base URL and regional domains: https://help.aliyun.com/en/model-studio/base-url

Endpoint formats were checked against the linked official documentation when this phase was implemented. Service providers can change available models and regional endpoint requirements; their live model catalog is not hard-coded. Use the exact model ID and endpoint provided by the account's current official documentation.

## Validation

Node.js 26 CI checks provider presets, model retry behavior, explicit backup selection, transient failure recovery, response/token metric aggregation, and the absence of endpoint/API-key leakage from metrics. Server integration tests verify that the authenticated preset endpoint and model metadata remain session-protected. No real user credentials or real NAS operations are used in CI.

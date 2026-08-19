# AI FinOps hardening

## Runtime ownership

- `AiExecutionService` remains the only Chat/RAG/tool execution path used by REST, WebSocket, WhatsApp, and AI workers.
- `OpenAiChatProvider` and `OpenAiEmbeddingProvider` are the only OpenAI SDK adapters. SDK retries are disabled (`maxRetries: 0`); `OpenAiRequestPolicy` owns the bounded retry policy.
- `AiPriceCatalogService` is the versioned pricing source. `AiCostLedgerService` persists the exact catalog snapshot and integer micro-USD cost used for each request.
- `AiPromptBudgetService` owns system/history/RAG/memory/tool-schema/tool-output/final-output budgets.
- Redis is an optional embedding optimization, not a correctness dependency. PostgreSQL content hashes are the persistent indexing deduplication boundary.
- Cost channels are the paid execution transport (`REST`, `WEBSOCKET`, `WHATSAPP`, or `BACKGROUND_JOB`); the logical conversation channel remains on `ai_conversations` and in the route (`ai.chat.<logical-channel>`).

## Cost model

Rates are stored as integer micro-USD per one million tokens. Chat cost separates uncached input, cached input, and output. Embedding cost uses embedding tokens only. `ai_cost_entries` stores model, attribution, usage, pricing version/source/effective date/rates, provider attempts, loop index, and exact cost. An unknown model, missing usage, failed request with unknown outcome, or retry with unknown usage is `UNPRICED`; it is never silently represented as free.

The built-in OpenAI catalog is the published list price snapshot captured from `https://openai.com/api/pricing/` on 2026-07-19. Operators may supply an approved JSON catalog through `AI_PRICE_CATALOG_JSON`. Existing ledger rows retain their original snapshots after a catalog update.

## Prompt and memory policy

RAG and memory are inserted as untrusted user-context sections, never system instructions. History retains the newest complete tool-call groups. Runtime tool results and schemas are budgeted, and every provider request sets `max_completion_tokens`. Dashboard tool schemas are filtered by the caller's permissions before budgeting; dispatch still performs the authoritative permission check.

Long-term recall requires all three conditions: the caller requests it, `AI_MEMORY_RECALL_ENABLED=true`, and the persisted session contains `context.memoryConsent=true`. Otherwise stale recalled memories are cleared and no recall embedding/search is executed. Vector and keyword recall both enforce tenant/customer/global-memory boundaries and expiry.

## Retry and idempotency policy

- Provider adapter: retry only 429, 5xx, and network/timeout errors; respect `Retry-After`; exponential backoff with jitter; never retry permanent 4xx. Stream creation may retry, but a stream is never replayed after iteration starts.
- AI BullMQ jobs: deterministic job ID and `attempts: 1`. Provider retries remain inside the adapter.
- AI turn ledger: `STARTED -> PROVIDER_IN_PROGRESS -> COMPLETED`; unknown provider/post-provider outcomes become `UNKNOWN_OUTCOME` and are not replayed automatically.
- Write tools: `PENDING -> EXECUTING -> SUCCEEDED`. Known permanent failures and unknown outcomes are terminal and require verification; automatic retry cannot repeat a side effect.

## Training files

TXT and Markdown can be uploaded to tenant-private R2 storage. Processing is:

1. `PENDING -> PROCESSING`
2. tenant-key validation and private fetch
3. size and UTF-8 validation
4. token-aware chunking and normalized SHA-256 hashing
5. embedding (required for training-file success)
6. transactional chunk/vector replacement
7. `INDEXED`

PDF/DOCX remain accepted as legacy metadata types but fail with `UNSUPPORTED_EXTRACTOR`; no OCR or unconfigured parser is implied. Failures save only a safe error code and clean source-owned partial chunks. Identical chunks in different source files keep independent source ownership but copy an existing pgvector value instead of buying another embedding.

## Analytics

**Cost-attribution route does not exist.** `GET /ai/analytics/cost-attribution` was documented here but never wired to a controller — no route ever returned this data; requesting it 404s. The underlying aggregation method (`AiAnalyticsService.costAttribution`, by feature/route/transport channel/request kind/provider/model, including failed/unpriced requests, retries, cached requests, and separate token classes) was removed 2026-08-17 (AI-021 remediation, PD-3: no product need identified for exposing this as a new public API surface — see `specs/012-ai-security-remediation/evidence/decisions/PD-3-cost-attribution.md`). Tenant-level total/monthly spend remains available through `AiAnalyticsService.cost()`, itself not currently exposed via a controller route either — see `usage`/`conversations`/`agents`/`knowledge` in `AiAnalyticsController` for the endpoints that are actually live.

## Deployment

1. Back up PostgreSQL.
2. Deploy/run migrations before API/worker code — `1730003800000-AiFinopsHardening`, then `1730054000000-AiExecutionMetricProcessingMode` (processing-mode/residency telemetry) and `1730055000000-AiCostEntryCacheWrite` (cache-write accounting). Both later ones are additive, nullable and backfill nothing.
3. Deploy API instances, then workers.
4. Leave `AI_MODEL_ROUTING_ENABLED=false` and rollout `0` initially.
5. Verify unpriced alerts, prompt truncation, queue failures, and training-file states (the `cost-attribution` route named here previously does not exist — see §Analytics).
6. Run the mocked evaluation suite. After API credits are added, run an approved live Arabic/English quality benchmark before increasing rollout.
7. Enable a small routing rollout, observe quality/cost/error metrics, then increase gradually.

Rollback routing or memory immediately through config flags. Application rollback is compatible with the additive schema. Do not drop the new ledger tables during an operational rollback; they contain historical accounting evidence.

## Environment variables

See `.env.example`. Safe initial production posture:

```dotenv
OPENAI_REQUEST_TIMEOUT_MS=30000
OPENAI_PROVIDER_MAX_RETRIES=2
OPENAI_RETRY_BASE_MS=500
AI_PRICE_CATALOG_JSON=
AI_PROMPT_SYSTEM_TOKENS=2000
AI_PROMPT_HISTORY_TOKENS=5000
AI_PROMPT_RAG_TOKENS=2500
AI_PROMPT_MEMORY_TOKENS=800
AI_PROMPT_TOOL_OUTPUT_TOKENS=1200
AI_PROMPT_TOOL_SCHEMA_TOKENS=6000
AI_PROMPT_MAX_INPUT_TOKENS=12000
AI_PROMPT_MAX_OUTPUT_TOKENS=800
AI_MODEL_CONTEXT_WINDOW_TOKENS=16384
AI_MEMORY_RECALL_ENABLED=false
AI_MODEL_ROUTING_ENABLED=false
AI_MODEL_ROUTING_ROLLOUT_PERCENT=0
AI_ECONOMY_MODEL=gpt-4.1-mini
AI_POWERFUL_MODEL=gpt-4o
AI_POWERFUL_FEATURES=
AI_POWERFUL_ROUTES=
AI_MODEL_ROUTING_STRICT=true
AI_EMBEDDING_CACHE_ENABLED=true
AI_EMBEDDING_QUERY_CACHE_TTL_SECONDS=86400
AI_EMBEDDING_CONTENT_CACHE_TTL_SECONDS=2592000
AI_EMBEDDING_VERSION=v2
AI_TRAINING_FILE_MAX_BYTES=10485760
```

`AI_EMBEDDING_VERSION` defaults to `v2`, not `v1`: the cached VALUE encoding changed from a JSON float array to a base64 Float32 buffer, so a `v1` key must never be read back as `v2`. An operator who explicitly set the variable keeps their value; only the default moved (one-time cache re-warm on upgrade).

`AI_ECONOMY_MODEL`, `AI_POWERFUL_MODEL`, and the platform setting `ai.default_model` are constrained to ids in `src/modules/ai/routing/ai-model-registry.ts`; an unregistered value is a boot-time (or 400) error rather than a first-turn surprise. `AI_MODEL_ROUTING_STRICT=true` additionally makes the router ignore an unregistered model already persisted on an `ai_agents` row, falling back to the tier default and logging once.

## Model release stages (GA vs PREVIEW)

Every registry entry carries `releaseStage`.

- **GA** — proven against this codebase's exact request shape by the live compatibility suite. Selectable everywhere: the agent DTO, `ai.default_model`, the dashboard model picker (`GET /ai/agents/models`), and the tier env vars.
- **PREVIEW** — registered, priced and capability-described, but its live compatibility has not been demonstrated here. Excluded from `AI_MODEL_IDS`, so it reaches **none** of the tenant-facing surfaces, and excluded from the router's automatic tier choice and capability substitution.

A PREVIEW model can only be selected by an operator naming it in `AI_ECONOMY_MODEL` / `AI_POWERFUL_MODEL` (validated against `AI_MODEL_IDS_ALL`). That is deliberate: one variable, instantly reversible, and never something a clinic admin can persist onto an agent row.

The GPT-5.6 family (`gpt-5.6-luna`, `gpt-5.6-terra`) ships as PREVIEW. Two facts make it different in kind and both are encoded in the registry rather than discovered at runtime:

1. `supportsTemperature: false`. The family accepts **only** the default temperature and returns 400 for any explicit value. `OpenAiChatProvider` omits the field entirely for such a model — before that, routing here would have failed 100% of requests on the first one.
2. `cacheWriteMultiplier: 1.25`. Cache **writes** bill above the uncached input rate, and reasoning tokens bill as output. Both are priced; a turn here is not as cheap as its input rate alone suggests.

A third fact was established live and is **not optional**: `/v1/chat/completions` rejects function tools for this family at any `reasoning_effort` except `'none'` — and **omitting the field produces the same 400**, because the model applies a default effort. Since nearly every turn here carries tools, both entries pin `reasoningEffort: 'none'`, and a spec asserts every reasoning-family model does. The plan's Responses-API fallback is therefore not needed for tool calling.

**Promotion procedure.** Run the live compatibility suite against the entry (it exercises PREVIEW models, asserts the temperature omission is load-bearing, and prints the raw `usage` object). Only then flip `releaseStage` to `'GA'` in the same commit that records the evidence. Both GPT-5.6 entries have now passed that gate; they stay PREVIEW because Stage 2 is sequenced after Stage 1 reaches 100%, not because anything is unproven.

## Cache-write accounting

`cached_input_tokens` is the discounted **read** of an already-cached prompt. `cache_write_tokens` is the other half — tokens written **into** the cache — and it is billed above the uncached input rate by models that support it. Only the difference above the input rate is charged, because those tokens are already counted once in `input_tokens`; charging the full 1.25× again would bill 2.25×.

`cache_write_price_microusd_per_million` stores the rate actually applied, exactly as the four existing price columns do, so a later catalog revision cannot retroactively change what a historical turn was billed. When a model declares no cache-write rate the surcharge is zero — every GPT-4.x model bills cache writes at the plain input rate.

The provider reads the token count defensively off the raw `usage` object: the installed SDK's `PromptTokensDetails` type predates cache-write billing, so the field is not reachable through the typed surface. **Confirm the field name from the live compat suite's usage dump before promoting any cache-write-billing model to GA** — a wrong name under-bills silently rather than failing.

`OPENAI_API_KEY` remains the existing project key. No replacement key is needed. Live provider verification and semantic quality evaluation are pending account credits.

Additional prompt-budget defaults are: system 2000, history 5000, RAG 2500, memory 800, tool output 1200, tool schema 6000, maximum input 12000, maximum output 800, and context window 16384 tokens. All are validated environment variables documented in `.env.example`.

## Live verification (opt-in)

Two suites exercise the real provider. Both live in `src/**` so plain `jest` discovers
them, and both SKIP unless `OPENAI_LIVE_TESTS=true` and `OPENAI_API_KEY` are set — so CI
runs them as skips and never spends money.

```bash
# Provider compatibility for every model in AI_MODEL_REGISTRY:
# non-streaming, streaming, temperature acceptance, and a tool-call round trip.
OPENAI_LIVE_TESTS=true npm run test:ai:live

# Arabic/English benchmark: candidate vs incumbent, side by side.
OPENAI_LIVE_TESTS=true \
AI_BENCHMARK_BASELINE=gpt-4o AI_BENCHMARK_CANDIDATE=gpt-4.1-mini \
npm run test:ai:benchmark
```

The compatibility suite is the gate before ANY routing rollout rung: a model can be
correctly priced, correctly gated, and still reject the exact request shape this codebase
sends (the GPT-5 family rejects the `temperature` the provider always sends).

The benchmark ASSERTS capability parity mechanically — same-language replies, and no
tool-calling regression against the incumbent — and PRINTS the actual Arabic and English
answers with per-case latency and cost. Reading that output is the approval step; answer
quality is deliberately not scored by another model.

## Verification status

- Mocked/unit/integration regression suite: enabled; it performs no network request.
- Backend and worker TypeScript build: enabled (the worker is compiled by the Nest build).
- Live OpenAI Arabic/English benchmark: **executed 2026-08-19, 12/12 pass** — `gpt-4.1-mini` measured **−85.2%** vs `gpt-4o` with no language or tool-calling regression. Recorded in `docs/AI_MODEL_LIVE_VERIFICATION.md`. (This line previously read "pending account credits"; the account has credits.)
- Live provider compatibility suite: **executed 2026-08-19, 38/38 pass** across all six registered models. It found the GPT-5.6 tool-calling constraint and fixed three false alias claims — see the same document. `gpt-5.6-luna` / `gpt-5.6-terra` remain PREVIEW by sequencing, not by lack of evidence.
- Migration SQL: compiled and covered by structural migration tests; execute against a backed-up staging clone before production. No database migration was run automatically against an unknown local/remote database.

## Reasoning-token watch (GPT-5.x only)

Reasoning tokens bill as **output**. A reasoning model can therefore cost more per turn than its output rate suggests while every rate in the catalog is correct. When first routing traffic to one, compare `completion_tokens` per turn against the incumbent at a small rollout percentage before widening — `ai_execution_metrics` already records it per turn, and `reasoningEffort` is pinned in the registry rather than left implicit precisely so this number does not move on its own.
- Repository lint: not blocked. `eslint.config.mjs` is active and enforces rules (including `prettier/prettier`) against the TypeScript source — confirmed 2026-08-17 by direct `npx eslint` execution. Any reported findings are the pre-existing CRLF/LF environment mismatch already on record, unrelated to this change (AI-026 remediation, `specs/012-ai-security-remediation/evidence/ai-026-lint-check.md`).

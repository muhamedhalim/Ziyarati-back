# Feature 011 audit harness — usage guide for reproduction-test authors

Not a task deliverable — an internal reference so every subsequent `test/security/ai-w*.spec.ts`
reuses the same fixtures correctly instead of rediscovering the same gotchas. Read this before
writing a new reproduction test.

## The building blocks

- `buildAiAuditHarness(options?)` (`ai-audit-harness.ts`) — boots the REAL `AppModule` against the
  real e2e Postgres (default: compose Postgres, port 5433, **no pgvector**; pass `{ pgvector: true }`
  for the pgvector-capable override on port 5434 — but see "pgvector mode" below, it needs its own
  provisioned database, not yet built as of this note). Returns `{ app, dataSource, provider,
  embedding, jwt, config, pgvectorAvailable, close() }`.
  - `provider` is a `ScriptedAiProvider` (`scripted-ai-provider.ts`) — the ONLY AI completion
    provider registered (real OpenAI is never in the `AI_COMPLETION_PROVIDERS` array). Use
    `.script([...])` to queue turns (`{ content }`, `{ toolCalls: [scriptedToolCall(name, args)] }`,
    or `.scriptFailure({ kind: 'timeout' | '429' | '5xx', ... })`), `.reset()` between scenarios,
    `.capturedRequests` / `.capturedMessages(callIndex)` to inspect exactly what reached the "model".
  - `embedding` is a `ScriptedEmbeddingProvider` — the ONLY embedding provider registered. Same
    reason: `.env` has a live `OPENAI_API_KEY` and nothing else stops a real embeddings call.
- `seedAiAudit(app, dataSource)` (`ai-audit-seed.ts`) → `{ tenantA, tenantB, discoveryTenantId,
  guestA, guestB }`. Each tenant carries `{ id, slug, agentId, kbId, customerIds: [2], staffUserId,
  staffProfileId, branchId, appointmentId }`. Call `teardownAiAuditSeed(dataSource, seed)` in
  `afterAll` — **always**, even if your test also does its own narrower cleanup; it's defensive and
  catch-and-continues per statement.
- `context-capture.ts` / `secret-scan.ts` — `scanText`/`scanValue`/`selfTest()` for W8; `summarizeMessages`/`renderCapturedRequestMarkdown`/`redactForEvidence` for building evidence-file excerpts out of `provider.capturedRequests`.

## Gotchas already found and fixed once — don't rediscover these

1. **Entitlement passes by default.** The platform is in `PLATFORM_FREE_MODE` (paid mode is off) in
   this environment, so `AccessControlService.assertAccess(..., AI_ASSISTANT, ...)` succeeds for any
   seeded tenant with no subscription setup needed. If you ever see an entitlement refusal you didn't
   script, something else is wrong — don't just add a subscription row to work around it without
   understanding why.
2. **Guest conversations need explicit ownership binding.** `conversations.start(tenantId, {})`
   alone does NOT bind a guest as the owner. Before any guest-scoped access (`AiConversationAccessService`,
   `PublicBookingContextService.getSelection/requireContext`) will succeed, you must additionally call
   `sessions.patch(tenantId, conv.id, { guestSubject: guestPrincipal.id })` — mirrors
   `ai-guest-isolation.e2e-spec.ts`'s `beforeAll`. Otherwise every access attempt fails
   `NOT_FOUND` (fail-closed "not an existence oracle" behavior), which looks like a pass for an
   isolation test but is actually a fixture bug — verify your OWN principal can reach the resource
   before asserting a FOREIGN principal cannot.
3. **Public booking tools need `tenant_settings.public_booking_enabled = true`.**
   `PublicBookingContextService.resolveTenantFromBranch` joins `tenant_settings` and defaults
   `public_booking_enabled` to `false` via `COALESCE` when no settings row exists (the seed fixture's
   default state). Insert one per tenant before exercising `select_clinic`/`select_branch`/any
   downstream public-booking tool:
   ```ts
   await dataSource.query(
     `INSERT INTO tenant_settings (tenant_id, public_booking_enabled) VALUES ($1, true)
      ON CONFLICT (tenant_id) DO UPDATE SET public_booking_enabled = true`,
     [tenantId],
   );
   ```
4. **`ai_messages.ai_conversation_id` is `varchar`; `ai_conversations.id` is `uuid`.** A direct SQL
   join/IN between them needs an explicit `::text` cast on both sides or Postgres throws "operator
   does not exist: character varying = uuid".
5. **Raw-SQL ledger tables use snake_case `tenant_id`, not TypeORM's quoted `"tenantId"`.** This
   applies to `ai_tool_calls`, `ai_cost_entries`, `ai_request_executions`, `ai_batch_jobs`,
   `ai_batch_items`, `ai_kb_embeddings` (migrations `1730000600000-AiToolCalls.ts`,
   `1730003800000-AiFinopsHardening.ts`, `1730003900000-AiBatchExecution.ts`,
   `1730000000000-AiPgVector.ts`) — all created by raw `CREATE TABLE` in a migration, not a TypeORM
   entity. `teardownAiAuditSeed` already cleans all of these up; if you delete a tenant yourself
   instead of using it, you will hit an FK violation on one of them the first time your test actually
   drives a turn or a tool call (cost/usage/idempotency rows get written).
6. **`ai_kb_embeddings` table only exists in pgvector mode** — a `does not exist` error deleting it
   on the default (5433) harness is expected and harmless (already caught-and-continued in
   `teardownAiAuditSeed`).
7. **A guest token is REJECTED on REST routes but ACCEPTED on the WS path.** Guest JWTs carry no
   `type: 'access'` claim (only `{ sub, tenantId, guest: true }`), so `JwtStrategy.validate`'s
   `payload.type !== 'access'` check refuses them (401) on any HTTP route behind `JwtAuthGuard`.
   `WsAuthService.authenticate` has a separate, explicit guest branch with no such check. This is a
   real, confirmed asymmetry — don't "fix" a test that discovers it; it's documented behavior.
8. **Driving a real turn**: `AiExecutionService.sendMessage(tenantId, aiConversationId, { content },
   'REST' | 'WHATSAPP', memoryLoader?)` and `.streamMessage(...)` are the layer that actually calls
   the provider (not `AiOrchestratorService.handle`, which wraps session/routing concerns you usually
   don't need for a security reproduction — call it directly only when you specifically need
   channel/session/routing behavior). Requires an existing `AiConversation` row
   (`conversations.start(tenantId, {})` — `AiConversationService`) with `status === ACTIVE` (the
   default on create).
9. **Tool calls round-trip through the SAME scripted provider twice per tool call**: once to emit the
   `toolCalls` array, once more for the follow-up turn after the tool result is fed back — script two
   entries (`[{ toolCalls: [...] }, { content: 'final answer' }]`) or the loop will exhaust the queue
   and fall back to the harmless default reply on the second call.
10. **`AiToolDispatchService.execute(ctx: ToolContext, call: AiToolCall)`** is the direct dispatcher
    entry point when you want to test one tool in isolation without a full turn/provider round-trip.
    `ToolContext` needs at minimum `{ tenantId, aiConversationId, principal?, permissions? }` —
    `principal` matters for any call that reaches an ownership check (public-booking selection
    reads), `permissions` for anything permission-gated. Real `AiToolCall.arguments` is a JSON
    **string**, not an object — use `JSON.stringify(...)`, or `scriptedToolCall(name, args)` from
    `scripted-ai-provider.ts` which does this for you and also gives the call a synthetic id.
11. **`buildAiAuditHarness({ pgvector: true })` needs its own provisioned database — run
    `node test/security/fixtures/provision-pgvector-db.js` once first** (T067). It builds
    `ziyarati_e2e` on the pgvector container (port 5434, a SEPARATE Postgres server from the
    default compose one on 5433) from the real migration chain, WITH `OPENAI_EMBEDDING_DIM=16`
    forced during that migration run so `ai_kb_embeddings.embedding` is `vector(16)` — matching
    `AUDIT_EMBEDDING_DIM` in `ai-audit-harness.ts`. Getting this dimension wrong (e.g. picking up
    `.env`'s `OPENAI_EMBEDDING_DIM=1536`) leaves a `vector(1536)` column and every embedding insert
    from the 16-dim `ScriptedEmbeddingProvider` fails at runtime with a pgvector dimension mismatch
    — verify with `SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid =
    'ai_kb_embeddings'::regclass AND attname = 'embedding'` (must read `vector(16)`) before trusting
    a boot. Idempotent — safe to re-run (drops+recreates the target database each time).
12. **(FIXED, 2026-08-15 — read only if you're curious why pgvector mode now works)**
    `ai-audit-harness.ts` used to `import { AppModule } from '../../../src/app.module'` at its own
    top level. `AppModule`'s `ConfigModule.forRoot({ envFilePath: '.env', cache: true, validate })`
    (`src/app.module.ts:71-76`) loads/validates env as a side effect of evaluating that `@Module()`
    decorator argument, which happens the instant `app.module.ts` is first `require()`'d — i.e. at
    the spec file's *import* time, before any of the file's own code (including
    `buildAiAuditHarness`'s `{ pgvector: true }` env mutation) has run. So the mutation was always
    too late: `dataSource.options.url` silently stayed on port 5433 even when
    `process.env.DATABASE_URL` correctly read 5434, and `pgvectorAvailable` was `false` even in
    "pgvector mode" — a keyword-only run that would have been indistinguishable from (and easy to
    misreport as) vector-path coverage. Fixed by `require()`-ing `AppModule` lazily, inside
    `buildAiAuditHarness()`, AFTER the env mutation. You don't need to do anything about this now —
    just don't add a NEW static top-level `import` of `AppModule` (or anything that transitively
    imports it) anywhere a pgvector-mode spec file's module graph could reach before
    `buildAiAuditHarness({ pgvector: true })` runs, or you'll silently reintroduce it. Full
    diagnostic trail: `evidence/raw/w5-path-proof.md` §0.
13. **`seedAiAudit()`'s tenant slug/email suffix (`ai-audit-seed.ts`'s `RUN` constant) is fixed ONCE
    PER PROCESS**, not per call — calling `seedAiAudit()` twice in the same spec FILE (same Jest
    worker process) collides on the second call (`duplicate key value violates unique constraint`
    on the tenant slug). One `buildAiAuditHarness()` + one `seedAiAudit()` per spec file (the
    existing pattern in every reference test below) is not just a style convention here — it's a
    hard requirement of this fixture as currently written.
14. **(FIXED, 2026-08-15, W8) `req.rawBody` was always `undefined`** — `buildAiAuditHarness()` called
    `moduleRef.createNestApplication()` with no options, unlike `main.ts:17`'s real
    `NestFactory.create(AppModule, { rawBody: true })`. Any raw-byte webhook-signature spec (HMAC over
    the exact request bytes — e.g. WhatsApp's `X-Hub-Signature-256`) would see EVERY request rejected
    at the "missing raw request body" branch regardless of whether the computed signature was
    correct, making the negative cases pass for the wrong reason and the positive case impossible.
    Fixed: `createNestApplication({ rawBody: true })`. You don't need to do anything about this now —
    it's already fixed in the shared fixture. If you're writing a NEW raw-body-signed webhook spec,
    `req.rawBody` now populates correctly; build the raw `Buffer` to HMAC from the SAME
    `JSON.stringify(body)` you pass to `.send(body)` (supertest serializes a plain object the same
    way).
15. **A webhook payload also needs a fresh, valid `timestamp` field inside the signed body if the
    endpoint enforces one** — WhatsApp's `whatsapp-webhook.service.ts`'s `enforceEventFreshness`
    (ZT-H02) runs AFTER signature verification and rejects `'missing'`/`'stale'`/`'future'`/
    `'malformed'` timestamps with its own distinct 401. If you're testing SIGNATURE verification
    specifically, give your payload a realistic `messages[0].timestamp`/`statuses[0].timestamp`
    (Unix seconds, `String(Math.floor(Date.now()/1000))`) so a correctly-signed payload doesn't
    accidentally fail on freshness instead — which looks like a signature-verification failure but
    is a completely different, later check.

## Verified-working reference tests

`ai-w0-harness.spec.ts` (boot/seed/teardown + one driven turn + one driven tool call),
`ai-w2-auth-boundary.spec.ts`, `ai-w2-tenant-override.spec.ts`, `ai-w2-session-patch.spec.ts` — all
green as of 2026-08-15, all built on exactly the pattern above. Copy their `beforeAll`/`afterAll`
shape rather than re-deriving it.

The 9 `ai-w8-*.spec.ts` files (T120–T130) are also green as of 2026-08-15 (58/58 tests, consolidated
run) and are additionally useful as reference for: driving a turn per channel (REST/WS-transport/
WHATSAPP-transport/guest) in one file, using `{ pgvector: true }` for real (the two files that need
embedding/vector-storage sinks — `ai-w8-tenant-authored-secret.spec.ts`,
`ai-w8-embedding-egress.spec.ts`), a full-Redis-keyspace-`SCAN` pattern (`AppRedisService.application`,
via `app.get(AppRedisService)`), swapping a REAL (non-scripted) provider class into the live
`AI_COMPLETION_PROVIDERS` array in place at runtime (`ai-w8-noop-provider-safety.spec.ts` — mutate the
array `harness.app.get(AI_COMPLETION_PROVIDERS)` returns rather than rebuilding the whole harness),
and calling the real `AiRealtimeGateway` methods directly against a synthetic `Socket` object (see
`ai-w8-error-sanitization.spec.ts`/`ai-w8-tenant-authored-secret.spec.ts` for the `fakeSocket()`
pattern) to reproduce WS-transport-specific behavior without a real socket.io client/server.

## Running your spec

```bash
cd Ziyarati-back && npx jest --config ./test/jest-security.json test/security/<your-file>.spec.ts
```

Full lane (before declaring your task done, or at minimum before reporting completion):

```bash
cd Ziyarati-back && npx jest --config ./test/jest-security.json
```

**Always actually run this and paste the real Test Suites/Tests summary line when reporting your
task complete.** Do not report a task done based on the code "looking correct" — every prior agent
in this session that skipped running its own test discovered a real bug (a type mismatch, a missing
FK cleanup, a missing ownership binding, a missing `tenant_settings` row) that only surfaced at
runtime.

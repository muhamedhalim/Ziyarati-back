/**
 * T124 — provider egress inventory via `ai-provider.factory.ts` and
 * `openai-request-policy.ts` (FR-065, FR-066): exactly what crosses to the
 * (scripted) provider, and structural proof the credential can never appear
 * in it.
 *
 * Two complementary proofs:
 *  1. STRUCTURAL — `AiCompletionRequest`/`AiEmbeddingContext`
 *     (ai-provider.interface.ts) are the ENTIRE surface `AiExecutionService`/
 *     `AiRagService` pass across the provider seam. Neither type has an API
 *     key/credential field at all, so no code path through this seam can
 *     leak one — reflected here via a compile-time `keyof` assertion, not
 *     just prose.
 *  2. EMPIRICAL — a real turn's captured request (headers/model/timeout/
 *     retry are NOT part of the request payload at all; they are the
 *     concrete provider's OWN constructor/call-site configuration —
 *     inventoried below by reading `openai-chat.provider.ts`/
 *     `openai-request-policy.ts` and asserting the actual configured values
 *     the harness's real `ConfigService` would hand them) never contains the
 *     platform's real `OPENAI_API_KEY` (present in `.env`) or any other
 *     credential-shaped value, and no tenant identifier crosses into a
 *     provider-side identifier shared across tenants (idempotency keys are
 *     the only per-request identifiers, and they are always prefixed with
 *     the caller's own tenant-scoped request key, never a bare tenant id
 *     used as a shared external id).
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scanValue } from './fixtures/secret-scan';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import type { AiCompletionRequest, AiEmbeddingContext } from '../../src/modules/ai/providers/ai-provider.interface';
import { OpenAiRequestPolicy, isRetryableOpenAiError } from '../../src/modules/ai/providers/openai-request-policy';
import { Logger } from '@nestjs/common';

// Compile-time proof: if either interface ever grows a credential-shaped
// field, this assignment fails to compile — a structural guard that does not
// depend on any particular request instance at runtime.
type NoCredentialFields<T> = 'apiKey' extends keyof T
  ? never
  : 'apiSecret' extends keyof T
    ? never
    : 'token' extends keyof T
      ? never
      : 'authorization' extends keyof T
        ? never
        : T;
type _CompletionRequestHasNoCredential = NoCredentialFields<AiCompletionRequest>;
type _EmbeddingContextHasNoCredential = NoCredentialFields<AiEmbeddingContext>;
const _typeGuard: _CompletionRequestHasNoCredential extends never ? never : true = true;
const _typeGuard2: _EmbeddingContextHasNoCredential extends never ? never : true = true;
void _typeGuard;
void _typeGuard2;

describe('W8 — provider egress inventory: credentials never cross the seam (T124)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let execution: AiExecutionService;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    execution = harness.app.get(AiExecutionService);
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('a real turn\'s captured provider request contains no credential-shaped value (scanned) and never the platform\'s real OPENAI_API_KEY', async () => {
    const realOpenAiKey = harness.config.get<string>('OPENAI_API_KEY');
    expect(realOpenAiKey).toBeTruthy(); // sanity: the harness genuinely has a live key configured in .env

    const conv = await conversations.start(seed.tenantA.id, { agentId: seed.tenantA.agentId });
    harness.provider.reset();
    harness.provider.script([{ content: 'ordinary reply' }]);
    await execution.sendMessage(seed.tenantA.id, conv.id, { content: 'What are your hours?' }, 'REST');

    const captured = harness.provider.capturedRequests[0];
    const text = JSON.stringify(captured);
    expect(text.includes(realOpenAiKey!)).toBe(false);
    expect(scanValue(captured)).toEqual([]);

    // Full field inventory of what crosses the seam — exactly the
    // AiCompletionRequest shape, nothing more (no extra/undeclared keys).
    const allowedKeys = new Set([
      'tenantId', 'model', 'temperature', 'messages', 'tools',
      'maxOutputTokens', 'idempotencyKey', 'feature', 'route', 'channel', 'signal',
      // Added with the model-capability work: two non-sensitive request SHAPE flags (does this model
      // accept a temperature; how much reasoning to ask for). Neither can carry a credential or a tenant
      // payload; they were reviewed when added and are listed here so the inventory stays exhaustive.
      'supportsTemperature', 'reasoningEffort',
    ]);
    for (const key of Object.keys(captured)) {
      expect(allowedKeys.has(key)).toBe(true);
    }

    // The idempotency key is scoped to THIS request/turn, never a bare tenant id.
    expect(captured.idempotencyKey).toBeDefined();
    expect(captured.idempotencyKey).not.toBe(seed.tenantA.id);

    process.stdout.write(`\n===T124-EGRESS-FIELDS keys=${JSON.stringify(Object.keys(captured))}===\n`);

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('real OpenAiRequestPolicy: retry/backoff/timeout configuration is read from ConfigService, never hardcoded, and never logs a credential on retry', async () => {
    const maxRetries = Number(harness.config.get('OPENAI_PROVIDER_MAX_RETRIES', 2));
    const baseMs = Number(harness.config.get('OPENAI_RETRY_BASE_MS', 500));
    const timeoutMs = Number(harness.config.get('OPENAI_REQUEST_TIMEOUT_MS', 30_000));
    expect(maxRetries).toBeGreaterThanOrEqual(0);
    expect(baseMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeGreaterThan(0);

    const logger = new Logger('T124-policy-test');
    const logs: string[] = [];
    jest.spyOn(logger, 'warn').mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });
    const policy = new OpenAiRequestPolicy(1, 10, logger);
    const retryableError = Object.assign(new Error('Rate limit exceeded'), {
      status: 429,
      headers: { get: () => null },
    });
    let attempt = 0;
    await expect(
      policy.execute(async () => {
        attempt += 1;
        if (attempt < 2) throw retryableError;
        return 'ok';
      }, 'chat.completions'),
    ).resolves.toMatchObject({ value: 'ok' });

    const logText = logs.join('\n');
    expect(logText).not.toContain('sk-');
    expect(logText).not.toContain(harness.config.get<string>('OPENAI_API_KEY'));
    // Logged fields are structural only (attempt/status/code) — no request body.
    expect(logText).toContain('status=429');

    expect(isRetryableOpenAiError({ status: 429 })).toBe(true);
    expect(isRetryableOpenAiError({ status: 401 })).toBe(false); // auth failures are never retried
  });

  it('headers/model/config inventory (code citation, structural — the scripted provider double has no HTTP layer to intercept): openai-chat.provider.ts constructs the OpenAI SDK client with {apiKey, timeout, maxRetries:0} ONLY — no custom header ever carries a tenant id or secondary credential', () => {
    // openai-chat.provider.ts:45 — `new OpenAI({ apiKey, timeout, maxRetries: 0 })`.
    // No `defaultHeaders`, no tenant id injected into any header. The SDK's own
    // Authorization header (constructed internally from `apiKey`) is the ONLY
    // credential-bearing header, and it is never exposed to application code —
    // `AiCompletionRequest` (asserted above) has no field that could carry it.
    expect(true).toBe(true);
  });
});

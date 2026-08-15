/**
 * T073 - embedding-cache key collision / cross-tenant cache hit (FR-047).
 *
 * The audit harness's `ScriptedEmbeddingProvider` (`fixtures/scripted-ai-
 * embedding-provider.ts`) has NO cache at all (always `cacheHits: 0,
 * cacheMisses: texts.length` - see its own docstring), so a harness-driven spec
 * cannot exercise the REAL cache key construction. This spec instead targets
 * `OpenAiEmbeddingProvider` (`src/modules/ai/providers/openai-embedding.
 * provider.ts`) directly - the actual production embedding cache - exactly the
 * same construction pattern already proven in
 * `src/modules/ai/providers/openai-embedding.provider.spec.ts` (a fake
 * `QueueService`/`AiCostLedgerService`, and the OpenAI SDK's `.embeddings.create`
 * replaced with a `jest.fn()` immediately after construction so no real network
 * call is ever possible - FR-103). That existing spec proves per-tenant cache
 * hit/miss and cache-version isolation for a SINGLE tenant; this file adds the
 * cross-TENANT case it does not cover: identical source text embedded under two
 * DIFFERENT tenants must never share a cache entry.
 *
 * The constructed key, read directly from source
 * (openai-embedding.provider.ts:147):
 *   `${cacheKeyPrefix()}ai:emb:${tenantId}:openai:${this.model}:${this.version}:${hash}`
 * `tenantId` is the THIRD colon-delimited segment (after an optional env
 * prefix) - structurally embedded in the key ITSELF, not merely passed as a
 * side channel, so a collision would require an actual SHA-256 hash collision
 * on the normalized text AND an identical tenantId string - i.e. structurally
 * impossible for two distinct tenant ids (verified at runtime below by reading
 * the actual keys used, not by re-deriving them independently).
 */
import { ConfigService } from '@nestjs/config';
import { OpenAiEmbeddingProvider } from '../../src/modules/ai/providers/openai-embedding.provider';

describe('AI-w5-embedding-cache-key - cross-tenant cache isolation on the REAL embedding cache key (T073)', () => {
  const quote = {
    status: 'PRICED',
    provider: 'openai',
    requestedModel: 'text-embedding-3-small',
    executionMode: 'STANDARD',
    costMicrousd: 1n,
  } as const;

  function setup() {
    const cache = new Map<string, string>();
    const queue = {
      kvGet: jest.fn(async (key: string) => cache.get(key) ?? null),
      kvMget: jest.fn(async (keys: string[]) => keys.map((k) => cache.get(k) ?? null)),
      kvSet: jest.fn(async (key: string, value: string) => {
        cache.set(key, value);
      }),
    };
    const costs = {
      quoteEmbedding: jest.fn(() => quote),
      record: jest.fn().mockResolvedValue({ inserted: true }),
    };
    const provider = new OpenAiEmbeddingProvider(
      new ConfigService({ OPENAI_API_KEY: 'mock-only-never-real', OPENAI_PROVIDER_MAX_RETRIES: 0 }),
      queue as any,
      costs as any,
    );
    // Real OpenAI SDK object is constructed (isConfigured() must read true to
    // match production wiring) but its ONLY network-capable method is replaced
    // BEFORE any await yields control - no real HTTP call is possible (FR-103).
    const create = jest.fn().mockResolvedValue({ data: [{ embedding: [0.11, 0.22, 0.33] }], usage: { total_tokens: 4 } });
    (provider as any).client = { embeddings: { create } };
    return { provider, queue, costs, create, cache };
  }

  it('identical source text embedded under two different tenants produces two DIFFERENT cache keys, each containing its own tenantId', async () => {
    const { provider, queue, create } = setup();
    const TENANT_A = 'tenant-aaaaaaaa-1111-1111-1111-111111111111';
    const TENANT_B = 'tenant-bbbbbbbb-2222-2222-2222-222222222222';
    const SAME_TEXT = 'identical source text — same clinic hours FAQ answer for every tenant';

    await provider.embed(TENANT_A, [SAME_TEXT], { kind: 'CONTENT' });
    await provider.embed(TENANT_B, [SAME_TEXT], { kind: 'CONTENT' });

    // Read the ACTUAL keys constructed at runtime (kvSet's first argument),
    // not a re-derivation of the formula — this is what "read the constructed
    // key at runtime" means per the task's Verify column.
    expect(queue.kvSet).toHaveBeenCalledTimes(2);
    const keyA = queue.kvSet.mock.calls[0][0] as string;
    const keyB = queue.kvSet.mock.calls[1][0] as string;

    expect(keyA).not.toBe(keyB); // structurally impossible to collide
    expect(keyA).toContain(`:${TENANT_A}:`);
    expect(keyB).toContain(`:${TENANT_B}:`);
    expect(keyA).not.toContain(TENANT_B);
    expect(keyB).not.toContain(TENANT_A);

    // Both calls hit the provider (no accidental cross-tenant cache hit
    // suppressed the second call) — confirms this at the PROVIDER level too,
    // not just the key string.
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('tenant B never observes a cache HIT for text tenant A already cached — the cache is queried by tenant B\'s OWN key, which was never written', async () => {
    const { provider, queue } = setup();
    const TENANT_A = 'tenant-cccccccc-3333-3333-3333-333333333333';
    const TENANT_B = 'tenant-dddddddd-4444-4444-4444-444444444444';
    const SAME_TEXT = 'another identical text both tenants happen to submit';

    const resultA = await provider.embed(TENANT_A, [SAME_TEXT], { kind: 'CONTENT' });
    expect(resultA.cacheHits).toBe(0);
    expect(resultA.cacheMisses).toBe(1);

    // Tenant A's cache write really did land (sanity — otherwise "tenant B
    // misses too" would be trivially true for the wrong reason).
    const sameTextResultA2 = await provider.embed(TENANT_A, [SAME_TEXT], { kind: 'CONTENT' });
    expect(sameTextResultA2.cacheHits).toBe(1); // tenant A's OWN second call hits its OWN entry

    const resultB = await provider.embed(TENANT_B, [SAME_TEXT], { kind: 'CONTENT' });
    expect(resultB.cacheHits).toBe(0); // NOT a hit, despite identical text and an existing cache entry for tenant A
    expect(resultB.cacheMisses).toBe(1);

    // Structural proof: the exact key tenant B's kvMget looked up is absent
    // from what tenant A wrote (kvMget is queried with B's own key, which is
    // simply never in the cache Map under that string).
    const tenantAKey = queue.kvSet.mock.calls[0][0] as string;
    const tenantBLookupKeys = queue.kvMget.mock.calls[queue.kvMget.mock.calls.length - 1][0] as string[];
    expect(tenantBLookupKeys).not.toContain(tenantAKey);
  });

  it('a THIRD tenant with a DIFFERENT model/version configuration also never collides — confirms tenantId is one independent segment among several, not the only isolation dimension', async () => {
    const { provider: providerV1 } = setup();
    const TENANT_A = 'tenant-eeeeeeee-5555-5555-5555-555555555555';
    await providerV1.embed(TENANT_A, ['version-isolation text'], { kind: 'CONTENT' });

    const cache2 = new Map<string, string>();
    const queue2 = {
      kvGet: jest.fn(async (key: string) => cache2.get(key) ?? null),
      kvMget: jest.fn(async (keys: string[]) => keys.map((k) => cache2.get(k) ?? null)),
      kvSet: jest.fn(async (key: string, value: string) => { cache2.set(key, value); }),
    };
    const costs2 = { quoteEmbedding: jest.fn(() => quote), record: jest.fn().mockResolvedValue({ inserted: true }) };
    const providerV2 = new OpenAiEmbeddingProvider(
      new ConfigService({ OPENAI_API_KEY: 'mock-only-never-real', OPENAI_PROVIDER_MAX_RETRIES: 0, AI_EMBEDDING_VERSION: 'v2-audit-test' }),
      queue2 as any,
      costs2 as any,
    );
    (providerV2 as any).client = { embeddings: { create: jest.fn().mockResolvedValue({ data: [{ embedding: [0.1] }], usage: { total_tokens: 2 } }) } };

    // Same tenant, same text, DIFFERENT provider/version config (simulating a
    // deploy that changed AI_EMBEDDING_VERSION) — a fresh miss, never a
    // collision with the other provider instance's cache Map (they are
    // entirely separate Maps here, but the ASSERTION that matters is that the
    // key ITSELF differs, so even a SHARED Redis would isolate them).
    const result = await providerV2.embed(TENANT_A, ['version-isolation text'], { kind: 'CONTENT' });
    expect(result.cacheHits).toBe(0);
    expect(queue2.kvSet.mock.calls[0][0]).toContain(':v2-audit-test:');
  });
});

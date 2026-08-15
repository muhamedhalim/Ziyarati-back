/**
 * T058 — cache and embedding-cache cross-tenant reproduction (FR-021, FR-047).
 *
 * The AI audit harness always overrides `AI_EMBEDDING_PROVIDER` with
 * `ScriptedEmbeddingProvider` (per `HARNESS_GUIDE.md` — the only embedding
 * provider ever registered, so a live `OPENAI_API_KEY` in `.env` can never be
 * used accidentally). That means the REAL cache (`OpenAiEmbeddingProvider`,
 * Redis-backed via `QueueService.kvGet/kvSet/kvMget`) never runs inside a
 * normal turn in this harness — so this file constructs the REAL provider
 * class directly (real `ConfigService`/`QueueService`/`AiCostLedgerService`
 * pulled from the harness's own DI container — not mocks) and drives its
 * REAL `embed()` method, to inspect the ACTUAL runtime cache-key composition
 * and hit/miss behavior, per T058's Verify clause ("inspect the actual cache
 * key composition at runtime").
 *
 * Both tenants' cache entries are pre-seeded so the test never needs a live
 * OpenAI call (`cacheHits` must equal the input length / `cacheMisses` must
 * be 0 for every assertion below — asserted explicitly, not merely hoped for).
 */
import { createHash } from 'node:crypto';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { OpenAiEmbeddingProvider } from '../../src/modules/ai/providers/openai-embedding.provider';
import { QueueService } from '../../src/queue/queue.service';
import { cacheKeyPrefix } from '../../src/queue/queue.constants';
import { AiCostLedgerService } from '../../src/modules/ai/cost/ai-cost-ledger.service';

/** Mirrors `encodeVector`/`decodeVector` in openai-embedding.provider.ts (not exported). */
function encodeVector(vector: number[]): string {
  return Buffer.from(Float32Array.from(vector).buffer).toString('base64');
}
function decodeVector(raw: string): number[] {
  const buf = Buffer.from(raw, 'base64');
  const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT);
  return Array.from(floats);
}

describe('AI-W4 embedding-cache cross-tenant reproduction (T058)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let provider: OpenAiEmbeddingProvider;
  let model: string;
  let version: string;

  const SAME_TEXT = 'Synthetic cache-isolation probe text — identical across both tenants.';
  const VECTOR_A = [1, 0, 0, 0.25];
  const VECTOR_B = [0, 1, 0, 0.75];

  function keyFor(tenantId: string): string {
    const normalized = SAME_TEXT.normalize('NFKC').trim().replace(/\s+/g, ' ');
    const hash = createHash('sha256').update(normalized).digest('hex');
    return `${cacheKeyPrefix()}ai:emb:${tenantId}:openai:${model}:${version}:${hash}`;
  }

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);

    const config = harness.config;
    const queue = harness.app.get(QueueService);
    const costs = harness.app.get(AiCostLedgerService);
    // Real class, real DI dependencies — the ONLY thing not real is that we
    // never let it reach the OpenAI client (both cache keys are pre-seeded
    // below, so every call in this file is a 100% cache hit).
    provider = new OpenAiEmbeddingProvider(config, queue, costs);

    model = config.get<string>('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small');
    version = config.get<string>('AI_EMBEDDING_VERSION', 'v2');

    const keyA = keyFor(seed.tenantA.id);
    const keyB = keyFor(seed.tenantB.id);
    await queue.kvSet(keyA, encodeVector(VECTOR_A), 120);
    await queue.kvSet(keyB, encodeVector(VECTOR_B), 120);
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('the runtime key composition includes the tenant id and differs between tenants for IDENTICAL source text', () => {
    const keyA = keyFor(seed.tenantA.id);
    const keyB = keyFor(seed.tenantB.id);
    expect(keyA).not.toBe(keyB);
    expect(keyA).toContain(seed.tenantA.id);
    expect(keyB).toContain(seed.tenantB.id);
    expect(keyA).not.toContain(seed.tenantB.id);
    expect(keyB).not.toContain(seed.tenantA.id);
  });

  it('tenant A embedding the SAME text retrieves ONLY tenant A\'s cached vector — 100% cache hit, zero provider call', async () => {
    const result = await provider.embed(seed.tenantA.id, [SAME_TEXT], { kind: 'QUERY' });
    expect(result.cacheHits).toBe(1);
    expect(result.cacheMisses).toBe(0); // proves no live OpenAI call was made
    const decoded = decodeVector(encodeVector(result.vectors[0])); // round-trip for float precision
    expect(decoded[0]).toBeCloseTo(VECTOR_A[0], 4);
    expect(decoded[1]).toBeCloseTo(VECTOR_A[1], 4);
    expect(decoded[3]).toBeCloseTo(VECTOR_A[3], 4);
  });

  it('tenant B embedding the SAME text retrieves ONLY tenant B\'s cached vector — never tenant A\'s, despite identical source text', async () => {
    const result = await provider.embed(seed.tenantB.id, [SAME_TEXT], { kind: 'QUERY' });
    expect(result.cacheHits).toBe(1);
    expect(result.cacheMisses).toBe(0);
    const decoded = result.vectors[0];
    expect(decoded[0]).toBeCloseTo(VECTOR_B[0], 4);
    expect(decoded[1]).toBeCloseTo(VECTOR_B[1], 4);
    expect(decoded[3]).toBeCloseTo(VECTOR_B[3], 4);
    // Definitive cross-tenant-hit check: tenant B's result must NOT equal
    // tenant A's vector (the only way a cross-tenant cache hit could occur).
    expect(Math.abs(decoded[0] - VECTOR_A[0])).toBeGreaterThan(0.5);
  });
});

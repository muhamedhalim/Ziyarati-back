/**
 * T080 — memory retention and deletion (FR-052).
 *
 * `expires_at` must be enforced on BOTH read (`AiMemoryVectorService.search`,
 * `ai-memory-vector.service.ts:108-118`: `WHERE ... AND (mem.expires_at IS
 * NULL OR mem.expires_at > now())`) and purge (`AiMemoryService.
 * cleanupExpired`, `ai-memory.service.ts:124-130`: `DELETE ... WHERE
 * expires_at < now()`), and deletion must remove the derived pgvector
 * embedding row too (`ai_memory_embeddings.memory_id` FK's `ON DELETE
 * CASCADE`, `ai-memory-vector.service.ts:47`).
 *
 * The embeddings sidecar table (`ai_memory_embeddings`) only exists in
 * pgvector mode (HARNESS_GUIDE.md gotcha #6) — this is the one W6 spec that
 * deliberately boots `buildAiAuditHarness({ pgvector: true })`, against the
 * already-provisioned `zt-audit-pgvector` container (verified read-only
 * before use: `vector` extension present, `ai_kb_embeddings.embedding` is
 * `vector(16)` matching `AUDIT_EMBEDDING_DIM` — this spec does NOT run the
 * destructive `provision-pgvector-db.js`, which would drop and recreate the
 * shared database other concurrent W4/W5 sessions may depend on). All
 * assertions are scoped to this run's own seeded tenants and cleaned up via
 * `teardownAiAuditSeed`, which already cascades `ai_memories` deletion (and
 * therefore `ai_memory_embeddings`, via the FK) for both seed tenants.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiMemoryService } from '../../src/modules/ai-memory/ai-memory.service';
import { AiMemoryVectorService } from '../../src/modules/ai-memory/ai-memory-vector.service';

describe('AI memory — retention and deletion, expiry enforced on read AND purge (T080, pgvector mode)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let memory: AiMemoryService;
  let vector: AiMemoryVectorService;

  const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago — already expired
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h from now — still valid

  const EXPIRED_CONTENT = 'Retention test expired memory: chronic migraine treatment plan details';
  const VALID_CONTENT = 'Retention test valid memory: chronic migraine treatment plan follow-up';
  const QUERY = 'chronic migraine treatment plan';

  let expiredId: string;
  let validId: string;

  async function embeddingExists(memoryId: string): Promise<boolean> {
    const rows = await harness.dataSource.query(`SELECT 1 FROM ai_memory_embeddings WHERE memory_id = $1`, [
      memoryId,
    ]);
    return rows.length > 0;
  }

  async function memoryExists(memoryId: string): Promise<boolean> {
    const rows = await harness.dataSource.query(`SELECT 1 FROM ai_memories WHERE id = $1`, [memoryId]);
    return rows.length > 0;
  }

  beforeAll(async () => {
    harness = await buildAiAuditHarness({ pgvector: true });
    expect(harness.pgvectorAvailable).toBe(true);
    seed = await seedAiAudit(harness.app, harness.dataSource);
    memory = harness.app.get(AiMemoryService);
    vector = harness.app.get(AiMemoryVectorService);
    expect(vector.isAvailable()).toBe(true);

    const expired = await memory.remember(seed.tenantA.id, {
      type: 'note',
      content: EXPIRED_CONTENT,
      importance: 5,
      expiresAt: PAST,
    });
    expiredId = expired.id;

    const valid = await memory.remember(seed.tenantA.id, {
      type: 'note',
      content: VALID_CONTENT,
      importance: 5,
      expiresAt: FUTURE,
    });
    validId = valid.id;
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('BEFORE state: both memory rows exist, and BOTH have a derived embedding row (embedding is written regardless of expiry)', async () => {
    expect(await memoryExists(expiredId)).toBe(true);
    expect(await memoryExists(validId)).toBe(true);
    expect(await embeddingExists(expiredId)).toBe(true);
    expect(await embeddingExists(validId)).toBe(true);
  });

  it('read enforcement: recall() (real pgvector search, not keyword fallback) excludes the expired memory, includes the valid one', async () => {
    const results = await memory.recall(seed.tenantA.id, { query: QUERY, limit: 10 });
    const contents = results.map((r) => r.content);
    expect(contents).toContain(VALID_CONTENT);
    expect(contents).not.toContain(EXPIRED_CONTENT);
  });

  it('read enforcement, cross-check: list({ activeOnly: "true" }) also excludes the expired memory', async () => {
    const page = await memory.list(seed.tenantA.id, { activeOnly: 'true', page: 1, limit: 50 } as never);
    expect(page.data.some((m) => m.content === VALID_CONTENT)).toBe(true);
    expect(page.data.some((m) => m.content === EXPIRED_CONTENT)).toBe(false);
  });

  it('read enforcement, control: list() WITHOUT activeOnly still shows the expired row exists (it is excluded from RECALL, not silently vanished from every view)', async () => {
    const page = await memory.list(seed.tenantA.id, { page: 1, limit: 50 } as never);
    expect(page.data.some((m) => m.content === EXPIRED_CONTENT)).toBe(true);
  });

  it('purge is tenant-scoped: cleanupExpired(tenantB.id) does NOT touch tenant A\'s expired row', async () => {
    const result = await memory.cleanupExpired(seed.tenantB.id);
    expect(result.deleted).toBe(0);
    expect(await memoryExists(expiredId)).toBe(true);
    expect(await embeddingExists(expiredId)).toBe(true);
  });

  it('purge: cleanupExpired(tenantA.id) deletes the expired memory row AND its derived embedding row; the valid memory and ITS embedding are untouched', async () => {
    const result = await memory.cleanupExpired(seed.tenantA.id);
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    // AFTER state — exact row presence, not inferred from the returned count alone.
    expect(await memoryExists(expiredId)).toBe(false);
    expect(await embeddingExists(expiredId)).toBe(false); // cascade-deleted

    expect(await memoryExists(validId)).toBe(true);
    expect(await embeddingExists(validId)).toBe(true);
  });

  it('purge is idempotent: a second cleanupExpired(tenantA.id) call finds nothing left to delete', async () => {
    const result = await memory.cleanupExpired(seed.tenantA.id);
    expect(result.deleted).toBe(0);
  });

  it('global purge (no tenantId argument) is scoped by expiry across tenants, not by a single tenant — proven with a fresh cross-tenant pair', async () => {
    const expiredB = await memory.remember(seed.tenantB.id, {
      type: 'note',
      content: 'Global-purge test: tenant B expired row',
      expiresAt: PAST,
    });
    const validB = await memory.remember(seed.tenantB.id, {
      type: 'note',
      content: 'Global-purge test: tenant B valid row',
      expiresAt: FUTURE,
    });

    const result = await memory.cleanupExpired(); // no tenantId — global
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    expect(await memoryExists(expiredB.id)).toBe(false);
    expect(await embeddingExists(expiredB.id)).toBe(false);
    expect(await memoryExists(validB.id)).toBe(true);
    expect(await embeddingExists(validB.id)).toBe(true);

    await harness.dataSource.query(`DELETE FROM ai_memories WHERE id = $1`, [validB.id]);
  });
});

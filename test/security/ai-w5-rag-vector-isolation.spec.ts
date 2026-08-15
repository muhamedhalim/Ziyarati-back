/**
 * T068 — RAG vector-path cross-tenant isolation (FR-042, FR-044, SC-003).
 *
 * Runs against the pgvector-mode harness (port 5434 — see HARNESS_GUIDE.md gotcha
 * #11: `node test/security/fixtures/provision-pgvector-db.js` must have been run
 * once first). Ingests a tenant-B knowledge chunk deliberately crafted to share
 * heavy vocabulary with a tenant-A query — `ScriptedEmbeddingProvider`'s bag-of-
 * words hash (`hashEmbed`, `scripted-ai-embedding-provider.ts:24-35`) means shared
 * words place the two texts close in cosine space, so this is a REAL semantic
 * collision, not a contrived one: §2 below proves tenant B's chunk would rank
 * #1 for tenant A's query if the tenant filter were absent. §1 then proves the
 * tenant+agent predicate in `AiRagService.vectorSearch()`
 * (`ai-rag.service.ts:115-133`) is a DIRECT clause on the `ai_kb_embeddings` query
 * itself — not post-retrieval filtering by the model or the caller — and that
 * zero tenant-B rows ever reach the result set despite the collision.
 *
 * Per HARNESS_GUIDE.md gotcha #13: exactly one `buildAiAuditHarness()` +
 * `seedAiAudit()` per file/process.
 */
import { EntityManager } from 'typeorm';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiKnowledgeIngestionService } from '../../src/modules/ai/ingestion/ai-knowledge-ingestion.service';
import { AiRagService } from '../../src/modules/ai/ai-rag.service';
import { hashEmbed } from './fixtures/scripted-ai-embedding-provider';

describe('AI-w5-rag-vector — cross-tenant vector-path isolation (T068)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let ingestion: AiKnowledgeIngestionService;
  let rag: AiRagService;

  // Crafted to share heavy vocabulary with the query below — a realistic
  // "confidential per-tenant policy" chunk an attacker would want leaked.
  const TENANT_B_SECRET_CONTENT =
    'Refund policy: patients can request a full refund within 30 days of payment by contacting billing support directly. This refund policy is confidential to this clinic.';
  const TENANT_A_QUERY = 'What is the refund policy? Can I get a refund within 30 days of payment?';

  const capturedQueries: { sql: string; params: unknown[] }[] = [];
  let originalQuery: typeof EntityManager.prototype.query;

  beforeAll(async () => {
    harness = await buildAiAuditHarness({ pgvector: true });
    seed = await seedAiAudit(harness.app, harness.dataSource);
    ingestion = harness.app.get(AiKnowledgeIngestionService);
    rag = harness.app.get(AiRagService);

    // Intercept every EntityManager.query() call (this is the code path
    // `vectorSearch()`'s `dataSource.transaction(async (m) => m.query(...))`
    // uses) so the test can assert on the ACTUAL SQL text + bound parameters
    // reaching Postgres, not just the returned rows.
    originalQuery = EntityManager.prototype.query;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(EntityManager.prototype, 'query').mockImplementation(function (this: EntityManager, sql: string, params?: unknown[]) {
      capturedQueries.push({ sql, params: params ?? [] });
      return originalQuery.call(this, sql, params);
    });
  }, 120_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    if (seed) await teardownAiAuditSeed(harness.dataSource, seed);
    if (harness) await harness.close();
  }, 60_000);

  it('sanity: the harness actually booted in pgvector mode (never report this as vector-path coverage otherwise)', () => {
    expect(harness.pgvectorAvailable).toBe(true);
  });

  it('§2 — proves the semantic collision is real: tenant B\'s chunk WOULD outrank tenant A\'s own content for tenant A\'s query, absent the tenant filter', async () => {
    const tenantBChunk = await ingestion.ingestChunk(seed.tenantB.id, seed.tenantB.agentId, TENANT_B_SECRET_CONTENT);
    const embed = harness.embedding;
    const { vectors } = await embed.embed(seed.tenantA.id, [TENANT_A_QUERY], { kind: 'QUERY' });
    const queryVec = vectors[0];
    expect(queryVec).toBeDefined();

    // Deliberately UNFILTERED BY TENANT (no `WHERE tenant_id = ...` at all —
    // that is the property under test) but scoped to the two known candidate
    // rows (tenant A's own seeded KB entry vs. tenant B's crafted chunk) rather
    // than a true full-table scan: this database is SHARED with other
    // concurrently-running audit sessions against the same pgvector container
    // (environment-record.md's own note on this), so an unbounded table scan
    // is vulnerable to picking up an unrelated session's row that happens to
    // score higher by coincidence — scoping to `kb_id IN (known candidates)`
    // preserves the "no tenant predicate" property being tested while removing
    // that cross-session noise source.
    const unfiltered = await harness.dataSource.query(
      `SELECT e.kb_id, e.tenant_id, 1 - (e.embedding <=> $1::vector) AS score
         FROM ai_kb_embeddings e
        WHERE e.kb_id = ANY($2::uuid[])
        ORDER BY e.embedding <=> $1::vector
        LIMIT 5`,
      [`[${queryVec.join(',')}]`, [tenantBChunk.id, seed.tenantA.kbId]],
    );
    expect(unfiltered.length).toBeGreaterThan(0);
    expect(unfiltered[0].kb_id).toBe(tenantBChunk.id);
    expect(unfiltered[0].tenant_id).toBe(seed.tenantB.id);
    // Confirms hashEmbed itself agrees these two texts are close (same
    // deterministic function the embedding provider uses internally).
    const directSim = cosine(hashEmbed(TENANT_A_QUERY, harness.embedding.dimension), hashEmbed(TENANT_B_SECRET_CONTENT, harness.embedding.dimension));
    expect(directSim).toBeGreaterThan(0.3); // meaningfully similar, not a coincidental near-zero overlap
  });

  it('§1 — tenant A\'s real retrieve() call returns ZERO tenant-B chunks, and the tenant+agent predicate is directly inside the executed query', async () => {
    capturedQueries.length = 0;
    const chunks = await rag.retrieve(seed.tenantA.id, seed.tenantA.agentId, TENANT_A_QUERY, 5);

    // No tenant-B content anywhere in the result set, despite §2 proving it
    // would have won on pure semantic similarity.
    expect(chunks.some((c) => c.content === TENANT_B_SECRET_CONTENT)).toBe(false);
    expect(chunks.every((c) => c.content !== TENANT_B_SECRET_CONTENT)).toBe(true);

    // The executed SQL against the vector sidecar table, captured verbatim.
    const vectorQuery = capturedQueries.find((q) => q.sql.includes('ai_kb_embeddings'));
    expect(vectorQuery).toBeDefined();
    expect(vectorQuery!.sql).toMatch(/WHERE\s+e\.tenant_id\s*=\s*\$2\s+AND\s+e\.agent_id\s*=\s*\$3/);
    // The predicate is bound to tenant A, never tenant B — this IS the isolation
    // boundary (a direct WHERE clause on the query itself), not a filter applied
    // to results after the fact.
    expect(vectorQuery!.params[1]).toBe(seed.tenantA.id);
    expect(vectorQuery!.params[2]).toBe(seed.tenantA.agentId);
    expect(vectorQuery!.params[1]).not.toBe(seed.tenantB.id);
  });

  it('cross-check: tenant B querying its OWN chunk with the same text DOES get it back (proves the isolation is tenant-scoped, not a blanket failure to match)', async () => {
    const chunks = await rag.retrieve(seed.tenantB.id, seed.tenantB.agentId, TENANT_A_QUERY, 5);
    expect(chunks.some((c) => c.content === TENANT_B_SECRET_CONTENT)).toBe(true);
  });
});

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return dot / denom;
}

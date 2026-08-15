/**
 * T071 — revoked/deleted document + derived embedding unreachability (FR-046, FR-052).
 *
 * Two surfaces, both checked at the DATABASE level (never just the HTTP response
 * shape, per the task's own "Verify" column):
 *
 *  1. Knowledge-base document deletion — `AiKnowledgeBaseService.remove()`
 *     (`ai-knowledge-base.service.ts:110-113`), a plain `this.kb.remove(entry)`.
 *     `ai_kb_embeddings.kb_id` is `REFERENCES ai_knowledge_bases(id) ON DELETE
 *     CASCADE` (`pgvector-bootstrap.service.ts:50`) — the sidecar row is deleted
 *     by the DATABASE itself, not by application code calling a second DELETE.
 *  2. Training-file-derived chunks — `AiKnowledgeIngestionService.cleanupSource()`
 *     (`ai-knowledge-ingestion.service.ts:335-340`), the exact method
 *     `AiTrainingFileService.remove()` calls (`ai-training-file.service.ts:471-478`
 *     — `await this.ingestion.cleanupSource(tenantId, id)`) before deleting the
 *     training-file row itself and its storage object. Driven directly via
 *     `ingestDocument()`/`cleanupSource()` rather than a full multipart upload +
 *     object-storage round trip (out of scope for a revocation proof — this
 *     exercises the exact same DB-write/DB-delete code path
 *     `AiTrainingFileService.process()`'s synchronous branch uses, at
 *     `ai-training-file.service.ts:308-314`, without the unrelated storage I/O).
 *
 * Both checks confirm pre/post row counts directly against `ai_knowledge_bases`
 * and `ai_kb_embeddings`, AND that a subsequent `AiRagService.retrieve()` call
 * (vector path, this harness is pgvector-mode) can no longer surface the deleted
 * content — "unreachable", not merely "the row I expected to find is gone".
 *
 * Per HARNESS_GUIDE.md gotcha #13: exactly one `buildAiAuditHarness()` +
 * `seedAiAudit()` per file/process.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiKnowledgeBaseService } from '../../src/modules/ai/ai-knowledge-base.service';
import { AiKnowledgeIngestionService } from '../../src/modules/ai/ingestion/ai-knowledge-ingestion.service';
import { AiRagService } from '../../src/modules/ai/ai-rag.service';
import { randomUUID } from 'node:crypto';

describe('AI-w5-rag-revocation — deleted document + derived embedding unreachability (T071)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let kbService: AiKnowledgeBaseService;
  let ingestion: AiKnowledgeIngestionService;
  let rag: AiRagService;

  beforeAll(async () => {
    harness = await buildAiAuditHarness({ pgvector: true });
    seed = await seedAiAudit(harness.app, harness.dataSource);
    kbService = harness.app.get(AiKnowledgeBaseService);
    ingestion = harness.app.get(AiKnowledgeIngestionService);
    rag = harness.app.get(AiRagService);
  }, 120_000);

  afterAll(async () => {
    if (seed) await teardownAiAuditSeed(harness.dataSource, seed);
    if (harness) await harness.close();
  }, 60_000);

  it('sanity: pgvector mode is actually active', () => {
    expect(harness.pgvectorAvailable).toBe(true);
  });

  it('1. deleting a knowledge-base document also removes its embedding row (DB-enforced CASCADE) and makes it unreachable via retrieve()', async () => {
    const content = 'Revocation-proof KB entry: our loyalty program grants a free visit after ten paid visits.';
    const entry = await kbService.create(seed.tenantA.id, { agentId: seed.tenantA.agentId, content });

    const before = await harness.dataSource.query(
      `SELECT
         (SELECT count(*)::int FROM ai_knowledge_bases WHERE id = $1) AS kb_rows,
         (SELECT count(*)::int FROM ai_kb_embeddings WHERE kb_id = $1) AS embedding_rows`,
      [entry.id],
    );
    expect(before[0].kb_rows).toBe(1);
    expect(before[0].embedding_rows).toBe(1); // proves an embedding really was written before we test its removal

    const preDeleteChunks = await rag.retrieve(seed.tenantA.id, seed.tenantA.agentId, 'loyalty program free visit ten paid visits', 5);
    expect(preDeleteChunks.some((c) => c.id === entry.id)).toBe(true); // reachable before deletion

    await kbService.remove(seed.tenantA.id, entry.id);

    const after = await harness.dataSource.query(
      `SELECT
         (SELECT count(*)::int FROM ai_knowledge_bases WHERE id = $1) AS kb_rows,
         (SELECT count(*)::int FROM ai_kb_embeddings WHERE kb_id = $1) AS embedding_rows`,
      [entry.id],
    );
    expect(after[0].kb_rows).toBe(0);
    expect(after[0].embedding_rows).toBe(0); // gone at the DB level, not merely "not returned by the API"

    const postDeleteChunks = await rag.retrieve(seed.tenantA.id, seed.tenantA.agentId, 'loyalty program free visit ten paid visits', 5);
    expect(postDeleteChunks.some((c) => c.id === entry.id)).toBe(false);
    expect(postDeleteChunks.some((c) => c.content === content)).toBe(false);
  });

  it('2. deleting a training-file source (cleanupSource — the exact method AiTrainingFileService.remove() calls) removes all its derived chunk + embedding rows', async () => {
    const sourceId = randomUUID(); // stands in for a training file's own id, per this file's docstring
    const text =
      'Revocation-proof training-file content, chunk one. Billing disputes must be raised within 14 days of the invoice date. ' +
      'Revocation-proof training-file content, chunk two, deliberately distinct wording so it forms a second chunk: patients may appeal a billing decision by emailing appeals@example.test.';

    const result = await ingestion.ingestDocument(seed.tenantA.id, seed.tenantA.agentId, text, sourceId, { requireEmbedding: true });
    expect(result.chunks).toBeGreaterThan(0);
    expect(result.embedded).toBe(result.chunks); // requireEmbedding:true guarantees full embedding coverage

    const before = await harness.dataSource.query(
      `SELECT
         (SELECT count(*)::int FROM ai_knowledge_bases WHERE "tenantId" = $1 AND source_id = $2) AS kb_rows,
         (SELECT count(*)::int FROM ai_kb_embeddings e JOIN ai_knowledge_bases k ON k.id = e.kb_id WHERE k."tenantId" = $1 AND k.source_id = $2) AS embedding_rows`,
      [seed.tenantA.id, sourceId],
    );
    expect(before[0].kb_rows).toBe(result.chunks);
    expect(before[0].embedding_rows).toBe(result.chunks);

    const preDeleteChunks = await rag.retrieve(seed.tenantA.id, seed.tenantA.agentId, 'billing disputes appeal invoice date', 5);
    expect(preDeleteChunks.some((c) => c.sourceId === sourceId)).toBe(true);

    await ingestion.cleanupSource(seed.tenantA.id, sourceId);

    const after = await harness.dataSource.query(
      `SELECT
         (SELECT count(*)::int FROM ai_knowledge_bases WHERE "tenantId" = $1 AND source_id = $2) AS kb_rows,
         (SELECT count(*)::int FROM ai_kb_embeddings e JOIN ai_knowledge_bases k ON k.id = e.kb_id WHERE k."tenantId" = $1 AND k.source_id = $2) AS embedding_rows`,
      [seed.tenantA.id, sourceId],
    );
    expect(after[0].kb_rows).toBe(0);
    expect(after[0].embedding_rows).toBe(0);

    const postDeleteChunks = await rag.retrieve(seed.tenantA.id, seed.tenantA.agentId, 'billing disputes appeal invoice date', 5);
    expect(postDeleteChunks.some((c) => c.sourceId === sourceId)).toBe(false);
  });
});

/**
 * T070 - metadata manipulation / unauthorized document identifiers (FR-044).
 *
 * Attempts, at every layer that accepts an id or agent reference from a caller,
 * to reach another tenant's knowledge-base entry, training file, or embedding
 * row by supplying a FOREIGN id or a foreign agentId - and, where the code
 * offers no tenant-scoped overload at all, calls the underlying query with the
 * tenant filter deliberately omitted to confirm no code path in this service
 * layer can even CONSTRUCT an unfiltered retrieval (the closest analog to
 * "tenant filters stripped" available without editing src/, which is out of
 * scope).
 *
 * Every assertion is a thrown AppError/empty result at the query level - never
 * a check on response wording (plan.md Test Strategy, FR-086).
 *
 * GENUINE FINDING (AI-W5-C01, see candidates-w4-w5-w6.md and assessment-rag.md):
 * `AiKnowledgeIngestionService.reembedChunk(tenantId, agentId, kbId, content)`
 * (`ai-knowledge-ingestion.service.ts:315-333`) tenant-scopes its
 * `ai_knowledge_bases` UPDATE correctly (`this.kb.update({ id: kbId, tenant: {
 * id: tenantId } }, ...)` matches zero rows for a foreign kbId - confirmed
 * below, content stays untouched) but then UNCONDITIONALLY calls
 * `upsertEmbedding(kbId, tenantId, agentId, vector)` regardless of whether that
 * update matched anything. `upsertEmbedding`'s SQL
 * (`:354-373`) is `INSERT ... ON CONFLICT (kb_id) DO UPDATE SET embedding =
 * EXCLUDED.embedding, tenant_id = EXCLUDED.tenant_id, agent_id =
 * EXCLUDED.agent_id` - keyed SOLELY on `kb_id` (the sidecar table's primary
 * key), with NO check that the existing row's tenant_id/agent_id match the
 * caller. Calling `reembedChunk` with a tenantId/agentId the caller controls
 * and a kbId belonging to ANOTHER tenant overwrites that tenant's
 * `ai_kb_embeddings` row's `tenant_id`, `agent_id`, AND `embedding` vector -
 * reassigning it to the CALLER's tenant. See the dedicated test below for the
 * live before/after proof. The one current production caller
 * (`AiKnowledgeBaseService.update()`, `ai-knowledge-base.service.ts:86-108`)
 * is itself gated by a preceding tenant-scoped `findOne()` (`:91`) that throws
 * NOT_FOUND for a foreign id before `reembedChunk` is ever reached - so this is
 * NOT currently reachable via any wired HTTP/tool/WS entry point as of this
 * audit, but it is a real, confirmed defect in the method's own contract
 * (verified by direct runtime invocation against the real service + database,
 * not by static reading), and would become exploitable the moment any future
 * caller invokes it (or `saveEmbedding`/`upsertEmbedding`) without first
 * re-verifying kb ownership itself.
 *
 * Per HARNESS_GUIDE.md gotcha #13: exactly one buildAiAuditHarness() +
 * seedAiAudit() per file/process.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiKnowledgeBaseService } from '../../src/modules/ai/ai-knowledge-base.service';
import { AiKnowledgeIngestionService } from '../../src/modules/ai/ingestion/ai-knowledge-ingestion.service';
import { AiRagService } from '../../src/modules/ai/ai-rag.service';
import { AppError } from '../../src/common/errors';

describe('AI-w5-rag-metadata-tamper - foreign KB/document ids + agent mismatch (T070)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let kbService: AiKnowledgeBaseService;
  let ingestion: AiKnowledgeIngestionService;
  let rag: AiRagService;
  let tenantBEntryId: string;
  const TENANT_B_CONTENT = 'Tamper-target content: tenant B internal escalation contact is escalations@example.test.';

  beforeAll(async () => {
    harness = await buildAiAuditHarness({ pgvector: true });
    seed = await seedAiAudit(harness.app, harness.dataSource);
    kbService = harness.app.get(AiKnowledgeBaseService);
    ingestion = harness.app.get(AiKnowledgeIngestionService);
    rag = harness.app.get(AiRagService);

    const entry = await kbService.create(seed.tenantB.id, { agentId: seed.tenantB.agentId, content: TENANT_B_CONTENT });
    tenantBEntryId = entry.id;
  }, 120_000);

  afterAll(async () => {
    if (seed) await teardownAiAuditSeed(harness.dataSource, seed);
    if (harness) await harness.close();
  }, 60_000);

  it('sanity: pgvector mode is active, and tenant A can read its OWN kb entries (proves the refusals below are tenant-specific, not a broken fixture)', async () => {
    expect(harness.pgvectorAvailable).toBe(true);
    const ownEntry = await kbService.create(seed.tenantA.id, { agentId: seed.tenantA.agentId, content: 'Tenant A control entry.' });
    const found = await kbService.findOne(seed.tenantA.id, ownEntry.id);
    expect(found.id).toBe(ownEntry.id);
  });

  it('create() refuses a foreign (tenant B) agentId supplied by tenant A', async () => {
    await expect(
      kbService.create(seed.tenantA.id, { agentId: seed.tenantB.agentId, content: 'Attacker-supplied content targeting a foreign agent.' }),
    ).rejects.toThrow(AppError);
  });

  it('findOne() refuses tenant A reading tenant B kb entry id directly', async () => {
    await expect(kbService.findOne(seed.tenantA.id, tenantBEntryId)).rejects.toThrow(AppError);
  });

  it('update() refuses tenant A modifying tenant B kb entry id (metadata tamper attempt)', async () => {
    await expect(
      kbService.update(seed.tenantA.id, tenantBEntryId, { content: 'TAMPERED by tenant A', sourceId: seed.tenantA.appointmentId }),
    ).rejects.toThrow(AppError);
    // Confirm the row is genuinely untouched, not just that the promise rejected.
    const stillTenantBContent = await kbService.findOne(seed.tenantB.id, tenantBEntryId);
    expect(stillTenantBContent.content).toBe(TENANT_B_CONTENT);
  });

  it('remove() refuses tenant A deleting tenant B kb entry id', async () => {
    await expect(kbService.remove(seed.tenantA.id, tenantBEntryId)).rejects.toThrow(AppError);
    const stillExists = await harness.dataSource.query(`SELECT count(*)::int AS n FROM ai_knowledge_bases WHERE id = $1`, [tenantBEntryId]);
    expect(stillExists[0].n).toBe(1);
  });

  it('ingestion.contentsByIds() - a foreign document id resolves to an EMPTY map under the wrong tenant, even though the id genuinely exists', async () => {
    const underOwnTenant = await ingestion.contentsByIds(seed.tenantB.id, [tenantBEntryId]);
    expect(underOwnTenant.size).toBe(1); // sanity: the id is real

    const underForeignTenant = await ingestion.contentsByIds(seed.tenantA.id, [tenantBEntryId]);
    expect(underForeignTenant.size).toBe(0);
    expect(underForeignTenant.has(tenantBEntryId)).toBe(false);
  });

  it('retrieve() with tenant A own id but tenant B agentId (mismatched pair) returns zero rows - the compound (tenant,agent) predicate cannot be tricked by a mismatched combination', async () => {
    const chunks = await rag.retrieve(seed.tenantA.id, seed.tenantB.agentId, 'internal escalation contact', 5);
    expect(chunks).toEqual([]);
  });

  it('a direct unfiltered vector query (bypassing AiRagService entirely, as a hypothetical "filters stripped" caller would) DOES cross tenants - confirming the WHERE clause in ai-rag.service.ts is the ONLY thing preventing this, not some other layer', async () => {
    // This intentionally exercises raw SQL with NO tenant/agent predicate at all
    // (never reachable through any actual application code path - see
    // w5-ingestion-chain.md and ai-rag.service.ts:115-133) to establish that the
    // isolation guarantee is carried entirely by that one WHERE clause, so a
    // regression there would have no other layer to catch it. Run BEFORE the
    // reembedChunk hijack test below, on tenantBEntryId, while its
    // ai_kb_embeddings.tenant_id is still genuinely tenant B's own.
    const unfiltered = await harness.dataSource.query(
      `SELECT tenant_id FROM ai_kb_embeddings WHERE kb_id = $1`,
      [tenantBEntryId],
    );
    expect(unfiltered[0]?.tenant_id).toBe(seed.tenantB.id);
    // The row is reachable with NO predicate - proving the isolation guarantee
    // is enforced by ai-rag.service.ts's own WHERE clause, not by a table-level
    // or row-level security policy that would refuse this query independently.
  });

  it('AI-004 — reembedChunk() with a foreign kbId hijacks the OTHER tenant\'s ai_kb_embeddings row (tenant_id/agent_id/embedding overwritten) even though the ai_knowledge_bases row content is correctly left untouched', async () => {
    const before = await kbService.findOne(seed.tenantB.id, tenantBEntryId);
    const beforeEmbeddingRow = await harness.dataSource.query(
      `SELECT tenant_id, agent_id FROM ai_kb_embeddings WHERE kb_id = $1`,
      [tenantBEntryId],
    );
    expect(beforeEmbeddingRow[0].tenant_id).toBe(seed.tenantB.id); // starts correctly owned by tenant B

    // Tenant A calls reembedChunk with ITS OWN tenantId/agentId but TENANT B's
    // kbId — the exact shape an attacker who merely knows/guesses a foreign
    // kbId (e.g. leaked via a log, another endpoint, or brute enumeration) could
    // construct, since reembedChunk's own signature accepts these as three
    // independent, uncorrelated parameters.
    await ingestion.reembedChunk(seed.tenantA.id, seed.tenantA.agentId, tenantBEntryId, 'attacker-controlled replacement text asserting a false loyalty discount code');

    // The knowledge-base CONTENT row is correctly protected (kb.update()'s own
    // tenant-scoped WHERE matched zero rows for a foreign kbId):
    const after = await kbService.findOne(seed.tenantB.id, tenantBEntryId);
    expect(after.content).toBe(TENANT_B_CONTENT);
    expect(after.content_hash).toBe(before.content_hash);

    // But the EMBEDDING SIDECAR row was silently reassigned to the CALLER's
    // (tenant A's) tenant/agent — a real cross-tenant row-ownership hijack,
    // confirmed by direct database inspection, not by an application-level read:
    const afterEmbeddingRow = await harness.dataSource.query(
      `SELECT tenant_id, agent_id FROM ai_kb_embeddings WHERE kb_id = $1`,
      [tenantBEntryId],
    );
    expect(afterEmbeddingRow[0].tenant_id).toBe(seed.tenantA.id); // HIJACKED — was tenant B
    expect(afterEmbeddingRow[0].agent_id).toBe(seed.tenantA.agentId); // HIJACKED — was tenant B's agent

    // Consequence 1: tenant B's OWN retrieve() can no longer find its own,
    // never-actually-deleted content via the vector path (the sidecar row that
    // pointed at it now belongs to a different tenant).
    const tenantBRetrieve = await rag.retrieve(seed.tenantB.id, seed.tenantB.agentId, 'escalation contact', 5);
    expect(tenantBRetrieve.some((c) => c.id === tenantBEntryId)).toBe(false);

    // Consequence 2 (the confidentiality-relevant half): tenant A's OWN
    // retrieve() now surfaces the hijacked row — and because the vector
    // SELECT JOINs back to ai_knowledge_bases on kb_id (ai-rag.service.ts:126),
    // the CONTENT returned is tenant B's ORIGINAL, UNCHANGED, still-confidential
    // text, not the attacker's replacement text (the kb row was never actually
    // updated). Tenant A can therefore make tenant B's private knowledge-base
    // content appear inside tenant A's own retrieval results.
    const tenantARetrieve = await rag.retrieve(seed.tenantA.id, seed.tenantA.agentId, 'internal escalation contact tamper target', 5);
    const leaked = tenantARetrieve.find((c) => c.id === tenantBEntryId);
    expect(leaked).toBeDefined();
    expect(leaked!.content).toBe(TENANT_B_CONTENT); // tenant B's real, private content — now visible to tenant A
  });
});

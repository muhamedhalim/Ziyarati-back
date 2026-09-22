/**
 * Clinic knowledge (RAG) — the vector path that production uses (pgvector is on in this DB).
 *
 * Both sides of the similarity are controlled here (a chosen unit vector stored for the KB row, and the
 * query embedding spied to another chosen vector), so what is measured is the RETRIEVAL LOGIC, not the
 * quality of any embedding model.
 *
 * Findings covered (Phase 4 — both now FIXED, converted from the original defect tests):
 *   F-08a  a KB row with no embedding yet is no longer invisible: an empty ANN result with no candidate
 *          rows at all now falls back to the keyword search, which finds it by exact text match
 *   F-08b  a relevance floor (RAG_MIN_SCORE) now rejects a chunk that scored below it; because the ANN
 *          join DID produce a candidate (just a bad one), this does NOT fall back to keyword — a
 *          keyword fallback here would defeat the floor via a single common-word match
 *   (control) tenant scoping holds on the vector path
 */
import { CANARY } from './fixtures/audit-seed';
import { bootAudit, whatsappTurn, saveEvidence, type AuditRuntime } from './fixtures/audit-runtime';
import { ReactiveProvider } from './fixtures/reactive-provider';
import { AiRagService } from '../../src/modules/ai/ai-rag.service';

const DIM = 1536;
const unit = (i: number) => Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));
const sql = (v: number[]) => `[${v.join(',')}]`;

describe('clinic knowledge retrieval (vector path)', () => {
  let rt: AuditRuntime;
  let rag: AiRagService;
  let reactive: ReactiveProvider;
  const observed: Record<string, any> = {};
  const q = (s: string, p: unknown[] = []) => rt.harness.dataSource.query(s, p);

  beforeAll(async () => {
    rt = await bootAudit();
    rag = rt.harness.app.get(AiRagService);
    reactive = new ReactiveProvider();
    rt.use(reactive);
    expect(rt.harness.pgvectorAvailable || (await q(`SELECT 1 FROM pg_extension WHERE extname='vector'`)).length === 1).toBe(true);
  }, 180_000);
  afterAll(async () => {
    jest.restoreAllMocks();
    saveEvidence('det-06-rag', observed);
    await rt?.close();
  }, 60_000);

  const knowledgeBlock = () =>
    reactive.capturedRequests[0].messages.find((m) => m.role === 'user' && (m.content ?? '').includes('Reference data only'))?.content ?? '';

  it('F-08a FIXED: a KB row with no embedding yet is found via the keyword fallback', async () => {
    const { full } = rt.seed;
    const timing: { retrievalMode?: string } = {};
    const found = await rag.retrieve(full.tenantId, null, 'cancellation policy', 5, timing);
    observed.no_embedding = { mode: timing.retrievalMode, chunks: found.length };
    // No row has been embedded yet for this tenant (the ANN join has zero candidates), so `retrieve()`
    // now falls all the way through to the keyword path — the timing it RECORDS matches the path that
    // ACTUALLY served the answer, not the vector path it merely tried first.
    expect(timing.retrievalMode).toBe('keyword');
    expect(found).toHaveLength(1);
    expect(found[0].content).toContain('Cancellation policy');
  });

  it('F-08b FIXED: an orthogonal (score 0) chunk is rejected by the relevance floor and never reaches the model', async () => {
    const { full } = rt.seed;
    await q(`INSERT INTO ai_kb_embeddings (kb_id, tenant_id, agent_id, embedding) VALUES ($1,$2,NULL,$3::vector)`, [full.kbId, full.tenantId, sql(unit(0))]);
    const embed = jest.spyOn(rt.harness.embedding, 'embed').mockResolvedValue({ vectors: [unit(1)], tokens: 1, cacheHits: 0 } as never);

    const timing: { retrievalMode?: string } = {};
    const chunks = await rag.retrieve(full.tenantId, null, 'What is the capital of France?', 5, timing);
    observed.no_floor_chunks = { mode: timing.retrievalMode, chunks };
    // A real candidate WAS found and scored (score 0, below RAG_MIN_SCORE) — unlike F-08a, this must
    // NOT fall back to keyword: keyword scoring can match on a single common word, which is exactly how
    // an unrelated chunk was previously shown to the model as "knowledge" for an off-topic question.
    expect(chunks).toHaveLength(0);
    expect(timing.retrievalMode).toBe('vector');

    reactive.setHandler(() => ({ content: 'ok' }));
    // Not the capital-of-France question: since Phase 3 the scope guard answers that one without retrieval
    // (F-10), so it would never reach the point this test observes. The floor is F-08 (Phase 4).
    await whatsappTurn(rt, full.tenantId, full.patientPhones!.x, 'Tell me a fun fact about penguins.');
    const block = knowledgeBlock();
    observed.no_floor_block = block;
    // With nothing above the floor, ai-prompt-budget.service.ts never emits the "Reference data only"
    // message at all — the unrelated clinic note is not presented to the model as reference data.
    expect(block).toBe('');
    embed.mockRestore();
  });

  it('CONTROL: vector retrieval is tenant-scoped — clinic B\'s identical vector is never returned for clinic FULL', async () => {
    const { full, b } = rt.seed;
    await q(`INSERT INTO ai_kb_embeddings (kb_id, tenant_id, agent_id, embedding) VALUES ($1,$2,NULL,$3::vector)`, [b.kbId, b.tenantId, sql(unit(0))]);
    const embed = jest.spyOn(rt.harness.embedding, 'embed').mockResolvedValue({ vectors: [unit(0)], tokens: 1, cacheHits: 0 } as never);
    const forFull = await rag.retrieve(full.tenantId, null, 'anything', 10);
    const forB = await rag.retrieve(b.tenantId, null, 'anything', 10);
    embed.mockRestore();
    expect(JSON.stringify(forFull)).not.toContain(CANARY.kbSecret);
    expect(JSON.stringify(forFull)).toContain('policy-marker');
    expect(JSON.stringify(forB)).toContain(CANARY.kbSecret);
    expect(JSON.stringify(forB)).not.toContain('policy-marker');
  });
});

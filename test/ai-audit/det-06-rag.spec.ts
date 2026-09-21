/**
 * Clinic knowledge (RAG) — the vector path that production uses (pgvector is on in this DB).
 *
 * Both sides of the similarity are controlled here (a chosen unit vector stored for the KB row, and the
 * query embedding spied to another chosen vector), so what is measured is the RETRIEVAL LOGIC, not the
 * quality of any embedding model.
 *
 * Findings covered:
 *   F-08a  a KB row without an embedding is invisible: the vector query succeeds with zero rows, so the
 *          keyword fallback (which would find it) never runs
 *   F-08b  there is no relevance floor: an orthogonal (score 0.000) chunk is still injected as "Reference data"
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

  it('F-08a DEFECT: a KB row with no embedding is never retrieved on the vector path, although the keyword fallback would find it', async () => {
    const { full } = rt.seed;
    const timing: { retrievalMode?: string } = {};
    const viaVector = await rag.retrieve(full.tenantId, null, 'cancellation policy', 5, timing);
    const viaKeyword = await (rag as unknown as { keywordSearch: (t: string, a: null, q: string, k: number) => Promise<{ content: string }[]> })
      .keywordSearch(full.tenantId, null, 'cancellation policy', 5);
    observed.no_embedding = { mode: timing.retrievalMode, vectorChunks: viaVector.length, keywordChunks: viaKeyword.length };
    expect(timing.retrievalMode).toBe('vector');
    expect(viaVector).toHaveLength(0);
    expect(viaKeyword).toHaveLength(1);
    expect(viaKeyword[0].content).toContain('Cancellation policy');
  });

  it('F-08b DEFECT: with cosine similarity 0 (orthogonal vectors) the chunk is still returned and injected into the model request', async () => {
    const { full } = rt.seed;
    await q(`INSERT INTO ai_kb_embeddings (kb_id, tenant_id, agent_id, embedding) VALUES ($1,$2,NULL,$3::vector)`, [full.kbId, full.tenantId, sql(unit(0))]);
    const embed = jest.spyOn(rt.harness.embedding, 'embed').mockResolvedValue({ vectors: [unit(1)], tokens: 1, cacheHits: 0 } as never);

    const chunks = await rag.retrieve(full.tenantId, null, 'What is the capital of France?', 5);
    observed.no_floor_chunks = chunks.map((c) => ({ score: c.score, content: c.content.slice(0, 60) }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].score).toBeCloseTo(0, 5);

    reactive.setHandler(() => ({ content: 'ok' }));
    // Not the capital-of-France question: since Phase 3 the scope guard answers that one without retrieval
    // (F-10), so it would never reach the point this test observes. The floor is F-08 (Phase 4).
    await whatsappTurn(rt, full.tenantId, full.patientPhones!.x, 'Tell me a fun fact about penguins.');
    const block = knowledgeBlock();
    observed.no_floor_block = block;
    expect(block).toContain('policy-marker'); // an unrelated clinic note is presented to the model as reference data
    expect(block).toContain('[1] Cancellation policy'); // the score (0) is stripped before the model sees it
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
